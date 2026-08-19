/**
 * plugin-dynpersist —— 动态插件持久化：让 agent 的自进化成果跨宿主重启存活。
 *
 * 背景：DynamicCordisRunnerService 纯进程内——宿主一重启，agent 用 cordis_define
 * 造的动态插件全部蒸发（memo-1 之死）。本插件补上这层，且不走服务包壳
 * （cordis 的 traceable 代理让方法替换不可靠——已实测证伪），改走事件流：
 * 会话日志本来就记录每次 cordis_define 的完整源码（model-visible ⟺ logged），
 * 本插件只需旁听 session/event，把 define/run/stop/undefine 的因果链落盘到
 * ./.dynplugins/<sessionId>--<pluginId>.json，宿主重启时回放（define + run）。
 *
 * 解析约定：cordis_define 的成功回执是文本 "Defined <pluginId>/<packageId>"，
 * 这里按此正则提取身份——tool-cordis 改了文案就要同步改这里。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DynamicCordisDefineRequest } from '@deepseek-ai/dsh-cordis-host-runner'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

export const name = 'plugin-dynpersist'
export const inject = ['dynamicCordisRunner', 'agents']

/** 一条持久化记录：一个动态插件的源码版本史与当前激活版本。 */
interface DynRecord {
  pluginId: string
  /** 建档时 define 用的原始 idPrefix（回放要用它，pluginId 带 -N 后缀不合法）。 */
  idPrefix: string
  purpose: string
  sessionId: string
  packages: Array<{ packageId: string; label: string; code: { host?: string; client?: string } }>
  /** 当前激活的 packageId；null = 已停止（重放时跳过）。 */
  activePackage: string | null
}

type DynCode = DynamicCordisDefineRequest['code']

interface DefineArgs {
  plugin: { kind: 'new'; idPrefix: string } | { kind: 'existing'; pluginId: string }
  name: string
  purpose: string
  code: DynCode
}

const DIR = './.dynplugins'
/** cordis_define 回执文本里的身份提取（见模块 docstring 的解析约定）。 */
/** idPrefix 合法化：cordis_define 只收 3-6 个小写字母；从 pluginId 剥 -N 后缀并净化。 */
function safeIdPrefix(raw: string): string {
  const cleaned = raw.replace(/-\d+$/, '').replace(/[^a-z]/g, '').slice(0, 6)
  return cleaned.length >= 3 ? cleaned : (cleaned + 'rep').slice(0, 6).padEnd(3, 'x')
}

const DEFINED_RE = /Defined (\S+)\/(\S+)/

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function codeValue(value: unknown): DynCode | undefined {
  const record = objectValue(value)
  if (!record) return undefined
  if (record.host !== undefined && typeof record.host !== 'string') return undefined
  if (record.client !== undefined && typeof record.client !== 'string') return undefined
  if (record.host === undefined && record.client === undefined) return undefined
  return {
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.client === 'string' ? { client: record.client } : {}),
  }
}

function defineArgsValue(value: unknown): DefineArgs | undefined {
  const record = objectValue(value)
  const plugin = objectValue(record?.plugin)
  const code = codeValue(record?.code)
  if (!record || !plugin || !code || typeof record.name !== 'string' || typeof record.purpose !== 'string') return undefined
  if (plugin.kind === 'new' && typeof plugin.idPrefix === 'string') {
    return { plugin: { kind: 'new', idPrefix: plugin.idPrefix }, name: record.name, purpose: record.purpose, code }
  }
  if (plugin.kind === 'existing' && typeof plugin.pluginId === 'string') {
    return { plugin: { kind: 'existing', pluginId: plugin.pluginId }, name: record.name, purpose: record.purpose, code }
  }
  return undefined
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

function parseRecord(raw: string): DynRecord {
  const value = objectValue(JSON.parse(raw) as unknown)
  if (!value || typeof value.pluginId !== 'string' || typeof value.idPrefix !== 'string'
    || typeof value.purpose !== 'string' || typeof value.sessionId !== 'string'
    || !Array.isArray(value.packages)
    || (value.activePackage !== null && typeof value.activePackage !== 'string')) {
    throw new Error('invalid dynamic plugin record')
  }
  const packages = value.packages.map((candidate): DynRecord['packages'][number] => {
    const pkg = objectValue(candidate)
    const code = codeValue(pkg?.code)
    if (!pkg || !code || typeof pkg.packageId !== 'string' || typeof pkg.label !== 'string') {
      throw new Error('invalid dynamic plugin package record')
    }
    return { packageId: pkg.packageId, label: pkg.label, code }
  })
  return {
    pluginId: value.pluginId,
    idPrefix: value.idPrefix,
    purpose: value.purpose,
    sessionId: value.sessionId,
    packages,
    activePackage: value.activePackage,
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

function recordPath(sessionId: string, pluginId: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, '_')
  return join(resolve(DIR), `${safe(sessionId)}--${safe(pluginId)}.json`)
}

export function apply(ctx: Context): void {
  mkdirSync(resolve(DIR), { recursive: true })
  /** 待配对的 define 调用：callId → { args, sessionId }（等 tool/result 回身份）。 */
  const pendingDefine = new Map<string, { args: DefineArgs; sessionId: SessionId }>()
  /** 待配对的 run 调用：callId → { pluginId, packageId, sessionId }（成功才记激活）。 */
  const pendingRun = new Map<string, { pluginId: string; packageId: string; sessionId: string }>()

  const load = (file: string): DynRecord => parseRecord(readFileSync(file, 'utf8'))
  const save = (file: string, rec: DynRecord): void => {
    writeFileSync(file, JSON.stringify(rec, null, 2))
  }
  const fileFor = (sessionId: string, pluginId: string) => recordPath(sessionId, pluginId)

  const resultText = (event: SessionEvent<'tool/result'>): string => {
    return event.data.message.content[0].content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
  }
  const resultMeta = (event: SessionEvent<'tool/result'>): { callId: string; isError: boolean } => {
    const msg = event.data.message
    return { callId: msg.source.callId, isError: msg.content[0].isError === true }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      const { callId, name, arguments: rawArgs } = event.data
      const args = parseObject(rawArgs)
      if (!args) return
      if (name === 'cordis_define') {
        const defineArgs = defineArgsValue(args)
        if (defineArgs) pendingDefine.set(callId, { args: defineArgs, sessionId: session.id })
      }
      if (name === 'cordis_run' && typeof args.pluginId === 'string' && typeof args.packageId === 'string') {
        pendingRun.set(callId, { pluginId: args.pluginId, packageId: args.packageId, sessionId: session.id })
      }
      if (name === 'cordis_stop' || name === 'cordis_undefine') {
        if (typeof args.pluginId !== 'string') return
        const file = fileFor(session.id, args.pluginId)
        if (!existsSync(file)) return
        if (name === 'cordis_undefine') {
          unlinkSync(file)
        } else {
          const rec = load(file)
          rec.activePackage = null
          save(file, rec)
        }
      }
      return
    }
    if (event.type === 'tool/result') {
      const { callId, isError } = resultMeta(event)
      const pending = pendingDefine.get(callId)
      if (pending) {
        pendingDefine.delete(callId)
        if (isError) return
        const m = DEFINED_RE.exec(resultText(event))
        if (!m) return
        const pluginId = m[1]
        const packageId = m[2]
        if (!pluginId || !packageId) return
        const { args, sessionId } = pending
        if (args.plugin.kind === 'new') {
          save(fileFor(sessionId, pluginId), {
            pluginId,
            idPrefix: args.plugin.idPrefix,
            purpose: args.purpose,
            sessionId,
            packages: [{ packageId, label: args.name, code: args.code }],
            activePackage: null,
          })
        } else {
          // existing：向既有插件追加版本；插件早于本插件存在时原地建档（历史从简）。
          const file = fileFor(sessionId, pluginId)
          const rec: DynRecord = existsSync(file)
            ? load(file)
            : { pluginId, idPrefix: safeIdPrefix(pluginId), purpose: args.purpose, sessionId, packages: [], activePackage: null }
          rec.packages.push({ packageId, label: args.name, code: args.code })
          save(file, rec)
        }
        return
      }
      const run = pendingRun.get(callId)
      if (run) {
        pendingRun.delete(callId)
        if (isError) return
        const file = fileFor(run.sessionId, run.pluginId)
        if (!existsSync(file)) return
        const rec = load(file)
        rec.activePackage = run.packageId
        save(file, rec)
      }
      return
    }
  })


  // ── 启动重放：define 激活版本 + run；回放后记录归一到新身份 ──
  const files = readdirSync(resolve(DIR))
  ctx.logger.info(`dynpersist: 重放扫描 ${files.length} 个文件`)
  const replay = async (file: string, agent: Agent): Promise<void> => {
    try {
      const rec: DynRecord = load(file)
      if (rec.activePackage === null || rec.sessionId !== String(agent.id)) return
      const pkg = rec.packages.find(p => p.packageId === rec.activePackage) ?? rec.packages.at(-1)
      if (!pkg) throw new Error('active dynamic plugin has no package')
      // HMR 可能重挂本插件；已运行的动态插件不重复注册服务。
      const existing = ctx.dynamicCordisRunner.snapshot(agent)
      const already = existing.some(p => p.pluginId === rec.pluginId)
      if (already) {
        console.log(`[dynpersist] ${rec.pluginId} 已在运行时，跳过回放`)
        return
      }
      const receipt = ctx.dynamicCordisRunner.define({
        sessionId: SessionId(rec.sessionId),
        plugin: { kind: 'new', idPrefix: rec.idPrefix },
        name: pkg.label,
        purpose: rec.purpose,
        code: pkg.code,
      })
      const result = await ctx.dynamicCordisRunner.run(agent, receipt.pluginId, receipt.packageId, 'run')
      if (!result.ok) throw new Error(result.message)
      save(file, {
        pluginId: receipt.pluginId,
        idPrefix: rec.idPrefix,
        purpose: rec.purpose,
        sessionId: rec.sessionId,
        packages: [{ packageId: receipt.packageId, label: receipt.name, code: pkg.code }],
        activePackage: receipt.packageId,
      })
      console.log(`[dynpersist] 回放动态插件 ${receipt.pluginId}/${receipt.name}`)
    } catch (e) {
      console.log(`[dynpersist] 回放 ${file} 失败: ${errorText(e)}`)
      // 保留激活标记；暂时性依赖或代码错误修复后，下次挂载仍可重试。
    }
  }

  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const file = join(resolve(DIR), f)
    try {
      const rec: DynRecord = load(file)
      if (rec.activePackage === null) {
        console.log(`[dynpersist] ${f} 已停止，跳过`)
        continue
      }
      const agent = ctx.agents.get(rec.sessionId as SessionId)
      if (agent) void replay(file, agent)
    } catch (e) {
      console.log(`[dynpersist] 读取 ${file} 失败: ${errorText(e)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      void replay(join(resolve(DIR), f), agent)
    }
  })
}
