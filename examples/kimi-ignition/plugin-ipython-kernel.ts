/**
 * plugin-ipython-kernel —— IPython 内核 daemon 的宿主播进程侧 Service（ctx.ipython）。
 *
 * 架构分工：内核（Python globals）活在 plugin-ipython-daemon.py 独立进程里，
 * 本 Service 只是它的薄客户端——宿主播进程热重载/重启只断开 socket，内核不死；
 * 重连在下次请求时惰性发生。daemon 进程本身也不归本 Service 所有：
 * 发现 socket 不存在时以 detached 形态拉起的 daemon 不随宿主退出。
 *
 * 协议：unix socket + NDJSON，详见 plugin-ipython-daemon.py 的模块 docstring。
 * 反向桥：内核代码 host.<method>(*args) 会以 host_call 消息到达本 Service，
 * 由 registerHostMethod 注册的处理器应答——多 agent 编排（subagent 等）经此进内核。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ipython: IPythonService
  }
}

export const name = 'plugin-ipython-kernel' // HMR 存活验证锚点

/** 一次 cell 的执行结果（daemon 应答的原样投影，error 非空即 cell 抛了异常）。 */
export interface ExecResult {
  stdout: string
  stderr: string
  /** cell 末尾孤立表达式的 repr；无则 null。 */
  result: string | null
  error: { type: string; message: string; traceback: string } | null
}

/** host 反向桥处理器：收到内核的 host.<name>(*args) 时调用，返回值原样回灌 cell。
 * @param kernel - 发起调用的内核名（约定 = 调用方 agent 的 sessionId，鉴权/路由依据）。 */
export type HostMethodHandler = (args: unknown[], kernel: string) => unknown | Promise<unknown>

export interface Config {
  /** daemon 的 unix socket 路径（相对 examples/kimi-ignition 解析）。 */
  socketPath: string
  /** daemon 脚本路径（相对 examples/kimi-ignition 解析）。 */
  daemonPath: string
  /** daemon 日志路径（相对 examples/kimi-ignition 解析）。 */
  logPath: string
  /** 拉起 daemon 用的 Python 解释器。 */
  pythonBin: string
  /** 等待 daemon 启动就绪的毫秒数。 */
  startTimeoutMs: number
  /** exec 的默认超时毫秒数（超时=向 daemon 发 interrupt，杀 cell 不杀内核）。 */
  execDefaultTimeoutMs: number
}

export class IPythonService extends Service {
  static Config: z<Config> = z.object({
    socketPath: z.string().default('./.ipython/daemon.sock'),
    daemonPath: z.string().default('./plugin-ipython-daemon.py'),
    logPath: z.string().default('./.ipython/daemon.log'),
    pythonBin: z.string().default('python3'),
    startTimeoutMs: z.number().min(100).default(5000),
    execDefaultTimeoutMs: z.number().min(1000).default(120_000),
  })

  private readonly conf: Config
  private socket: Socket | undefined
  private connecting: Promise<Socket> | undefined
  private buffer = ''
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private readonly hostMethods = new Map<string, HostMethodHandler>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ipython')
    this.conf = config
    // 卸载语义：只断开 socket——daemon 与内核属于"宿主之外的资产"，热重载不杀。
    ctx.effect(() => () => this.teardown(), 'ipython: disconnect')
  }

  /** 注册 host 反向桥方法；返回注销器（注册方用 ctx.effect 持有）。 */
  registerHostMethod(method: string, handler: HostMethodHandler): () => void {
    if (this.hostMethods.has(method)) throw new Error(`host 方法 "${method}" 已注册`)
    this.hostMethods.set(method, handler)
    return () => { this.hostMethods.delete(method) }
  }

  /** 在内核 kernel 里执行一个 cell；超时/中止 = 发 interrupt 杀 cell（内核存活）。 */
  async exec(kernel: string, code: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? this.conf.execDefaultTimeoutMs
    const req = this.request<ExecResult>({ op: 'exec', kernel, code })
    return new Promise<ExecResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const interruptAndFail = (message: string) => {
        void this.interrupt(kernel).catch(() => undefined)
        cleanup()
        reject(new Error(message))
      }
      const onAbort = () => interruptAndFail('exec 被调用方中止，已向内核发 interrupt')
      const timer = setTimeout(() => interruptAndFail(`exec 超时（${timeoutMs}ms），已向内核发 interrupt`), timeoutMs)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      req.then(
        // daemon 应答含 ok/id 等协议字段，工具 canonical 值只保留执行结果四元组
        (v) => { cleanup(); resolve({ stdout: v.stdout, stderr: v.stderr, result: v.result, error: v.error }) },
        (e) => { cleanup(); reject(e) },
      )
    })
  }

  /** 打断内核正在执行的 cell（杀 cell 不杀内核）；无 cell 在跑时 interrupted=false。 */
  async interrupt(kernel: string): Promise<boolean> {
    return (await this.request<{ interrupted: boolean }>({ op: 'interrupt', kernel })).interrupted
  }

  /** 清空内核全部变量（host 桥对象保留）。 */
  async reset(kernel: string): Promise<void> {
    await this.request({ op: 'reset', kernel })
  }

  /** 内核变量落盘到 path（每变量独立序列化，不可序列化的点名跳过）。 */
  async snapshot(kernel: string, path: string): Promise<{ saved: string[]; skipped: string[] }> {
    return this.request({ op: 'snapshot', kernel, path })
  }

  /** 从 path 恢复内核变量。 */
  async restore(kernel: string, path: string): Promise<{ restored: string[]; failed: string[] }> {
    return this.request({ op: 'restore', kernel, path })
  }

  /** 活性探测；同时列出 daemon 里现存的内核名。 */
  async ping(): Promise<string[]> {
    return (await this.request<{ kernels: string[] }>({ op: 'ping' })).kernels
  }

  private teardown(): void {
    this.socket?.destroy()
    this.socket = undefined
    this.connecting = undefined
    for (const [, p] of this.pending) p.reject(new Error('ipython service 卸载，连接已断开'))
    this.pending.clear()
  }

  private async request<T = any>(fields: Record<string, unknown>): Promise<T> {
    const socket = await this.ensureConnection()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(JSON.stringify({ ...fields, id }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** 惰性连接：socket 不在就建（daemon 不在就先拉 daemon），并发请求共享同一次连接建立。 */
  private ensureConnection(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting
    this.connecting = this.connectWithRetry().then((s) => {
      this.connecting = undefined
      return s
    }, (e) => {
      this.connecting = undefined
      throw e
    })
    return this.connecting
  }

  private async connectWithRetry(): Promise<Socket> {
    const sockPath = resolve(this.conf.socketPath)
    // 先试连一次：socket 文件存在不代表 daemon 活着（进程死后文件是陈尸）；
    // 连不上才拉起新 daemon——daemon 内部 bind 前会 unlink 旧文件，接管是安全的。
    try {
      return await this.attach(sockPath)
    } catch {
      this.spawnDaemon()
    }
    const deadline = Date.now() + this.conf.startTimeoutMs
    let lastErr: Error | undefined
    while (Date.now() < deadline) {
      try {
        return await this.attach(sockPath)
      } catch (e) {
        lastErr = e as Error
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    throw new Error(`连接 ipython daemon 失败（${this.conf.startTimeoutMs}ms）：${lastErr?.message}`)
  }

  /** detached 拉起 daemon：不随宿主播进程退出，宿主重启后重新 attach 同一个 daemon。 */
  private spawnDaemon(): void {
    const child = spawn(this.conf.pythonBin, [resolve(this.conf.daemonPath), resolve(this.conf.socketPath), resolve(this.conf.logPath)], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    child.on('error', (e) => this.ctx.logger.warn('ipython daemon 拉起失败: %s', e.message))
  }

  private attach(sockPath: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(sockPath)
      s.once('error', reject)
      s.once('connect', () => {
        s.removeListener('error', reject)
        s.setNoDelay(true)
        s.on('data', (chunk) => this.onData(chunk))
        s.on('error', () => this.onSocketDead(s))
        s.on('close', () => this.onSocketDead(s))
        this.socket = s
        resolve(s)
      })
    })
  }

  private onSocketDead(s: Socket): void {
    if (this.socket !== s) return
    this.socket = undefined
    for (const [, p] of this.pending) p.reject(new Error('ipython daemon 连接中断'))
    this.pending.clear()
  }

  /** NDJSON 分帧：按 id 路由应答；host_call 走反向桥处理器。 */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.kind === 'host_call') {
        void this.answerHostCall(msg)
        continue
      }
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.error?.message ?? 'daemon 返回失败'))
    }
  }

  private async answerHostCall(msg: { id: string; kernel?: string; method: string; args: unknown[] }): Promise<void> {
    const handler = this.hostMethods.get(msg.method)
    let reply: Record<string, unknown>
    if (!handler) {
      reply = { ok: false, error: `宿主未注册方法 "${msg.method}"` }
    } else {
      try {
        reply = { ok: true, value: (await handler(msg.args, msg.kernel ?? 'unknown')) ?? null }
      } catch (e) {
        reply = { ok: false, error: (e as Error).message }
      }
    }
    this.socket?.write(JSON.stringify({ kind: 'host_reply', id: msg.id, ...reply }) + '\n')
  }
}

/** 条目级配置校验：cordis 从模块导出取 Config（registry 的 `Config: plugin.Config`），默认值在此落齐。 */
export const Config: z<Config> = IPythonService.Config

export function apply(ctx: Context, config: Config): void {
  new IPythonService(ctx, config)
}
