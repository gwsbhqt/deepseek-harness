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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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

const DIR = './.dynplugins'
/** cordis_define 回执文本里的身份提取（见模块 docstring 的解析约定）。 */
/** idPrefix 合法化：cordis_define 只收 3-6 个小写字母；从 pluginId 剥 -N 后缀并净化。 */
function safeIdPrefix(raw: string): string {
  const cleaned = raw.replace(/-\d+$/, '').replace(/[^a-z]/g, '').slice(0, 6)
  return cleaned.length >= 3 ? cleaned : (cleaned + 'rep').slice(0, 6).padEnd(3, 'x')
}

const DEFINED_RE = /Defined (\S+)\/(\S+)/

function recordPath(sessionId: string, pluginId: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, '_')
  return join(resolve(DIR), `${safe(sessionId)}--${safe(pluginId)}.json`)
}

export function apply(ctx: Context): void {
  mkdirSync(resolve(DIR), { recursive: true })
  const runner = ctx.dynamicCordisRunner as any
  /** 待配对的 define 调用：callId → { args, sessionId }（等 tool/result 回身份）。 */
  const pendingDefine = new Map<string, { args: any; sessionId: string }>()
  /** 待配对的 run 调用：callId → { pluginId, packageId, sessionId }（成功才记激活）。 */
  const pendingRun = new Map<string, { pluginId: string; packageId: string; sessionId: string }>()

  const load = (file: string): DynRecord => JSON.parse(readFileSync(file, 'utf8'))
  const save = (file: string, rec: DynRecord) => writeFileSync(file, JSON.stringify(rec, null, 2))
  const fileFor = (sessionId: string, pluginId: string) => recordPath(sessionId, pluginId)

  const resultText = (event: any): string => {
    try {
      return event.data.message.content[0].content.map((b: any) => b.text ?? '').join('\n')
    } catch {
      return ''
    }
  }
  const resultMeta = (event: any): { callId: string; isError: boolean } => {
    const msg = event.data.message
    return { callId: msg.source?.callId, isError: msg.content[0]?.isError === true }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      const { callId, name, arguments: rawArgs } = event.data as any
      let args: any
      try {
        args = JSON.parse(rawArgs)
      } catch {
        return
      }
      if (name === 'cordis_define') pendingDefine.set(callId, { args, sessionId: session.id })
      if (name === 'cordis_run') pendingRun.set(callId, { pluginId: String(args.pluginId), packageId: String(args.packageId), sessionId: session.id })
      if (name === 'cordis_stop' || name === 'cordis_undefine') {
        const file = fileFor(session.id, String(args.pluginId))
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
        const [, pluginId, packageId] = m
        const { args, sessionId } = pending
        if (args.plugin?.kind === 'new') {
          save(fileFor(sessionId, pluginId), {
            pluginId,
            idPrefix: String(args.plugin.idPrefix ?? pluginId),
            purpose: String(args.purpose ?? ''),
            sessionId,
            packages: [{ packageId, label: String(args.name ?? ''), code: args.code }],
            activePackage: null,
          })
        } else {
          // existing：向既有插件追加版本；插件早于本插件存在时原地建档（历史从简）。
          const file = fileFor(sessionId, pluginId)
          const rec: DynRecord = existsSync(file)
            ? load(file)
            : { pluginId, idPrefix: safeIdPrefix(pluginId), purpose: String(args.purpose ?? ''), sessionId, packages: [], activePackage: null }
          rec.packages.push({ packageId, label: String(args.name ?? ''), code: args.code })
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
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const file = join(resolve(DIR), f)
    try {
      const rec: DynRecord = load(file)
      if (rec.activePackage === null) {
        console.log(`[dynpersist] ${f} 已停止，跳过`)
        continue
      }
      const pkg = rec.packages.find((p) => p.packageId === rec.activePackage) ?? rec.packages.at(-1)!
      const agent = ctx.agents.get(rec.sessionId as SessionId)
      if (!agent) {
        ctx.logger.warn(`dynpersist: ${rec.pluginId} 的属主会话 ${rec.sessionId} 未存活，跳过回放`)
        continue
      }
      // 幂等：回放可能因 hmr 重挂本插件而重复执行；目标插件已在运行时里就跳过，
      // 否则重复回放会在动态插件 ctx.provide 时撞服务重名（memoPad 冲突的教训）。
      const existing = runner.snapshot(agent) as any[]
      const already = existing.some((p) => p.pluginId === rec.pluginId)
      if (already) {
        console.log(`[dynpersist] ${rec.pluginId} 已在运行时，跳过回放`)
        continue
      }
      const receipt = runner.define({
        sessionId: rec.sessionId,
        plugin: { kind: 'new', idPrefix: rec.idPrefix },
        name: pkg.label,
        purpose: rec.purpose,
        code: pkg.code,
      })
      runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
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
      // console.log 而不是 logger.warn：本组合下 warn 不显示（已踩过），失败必须看得见
      console.log(`[dynpersist] 回放 ${f} 失败: ${(e as Error).message}`)
      // 回放失败的记录退休（activePackage=null）：多半是运行时已有等价物
      // （agent 自愈重建的兄弟），留着只会让每次重启都撞同一个冲突。
      try {
        const rec = load(file)
        rec.activePackage = null
        save(file, rec)
      } catch { /* 记录损坏时退休也免了 */ }
    }
  }
}
