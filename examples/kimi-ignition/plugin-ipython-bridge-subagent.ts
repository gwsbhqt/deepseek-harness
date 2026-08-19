/**
 * plugin-ipython-bridge-subagent —— 把 ctx.subagents 编排能力桥进 Python 内核。
 *
 * 一方即三方：本插件不享有任何特权——它和 k3 用 cordis_define 写的动态桥插件
 * （如 self-2 的 host.subagent_start）走同一个开放注册表
 * （ctx.ipython.registerHostMethod），区别只在它是静态白名单条目。
 * 从 cordis.yml 删掉本条，host.subagent_* 就从内核里干净消失。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const name = 'plugin-ipython-bridge-subagent' // remount
export const inject = ['ipython', 'subagents', 'agents', 'systemPrompt']

const BRIDGE_PROMPT = `内核 host 桥的编排原语（由 plugin-ipython-bridge-subagent 提供）：
- host.subagent_spawn(description, prompt)：派一个持久工人（continuable，返回工人 id）
- host.subagent_list()：列出你的工人（id/activity/mode）
- host.subagent_send(id, message)：给工人续话派活
编排由此可写成代码：循环/条件批量派工、fan-out 收割，而不是逐个工具调用。`

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'bridge:subagent', order: 121, text: BRIDGE_PROMPT })

  // 调用方鉴权：内核名约定 = agent 的 sessionId；无名内核（unknown/shared）拒绝服务。
  const callerAgent = (kernel: string): Agent => {
    const agent = ctx.agents.get(kernel as SessionId)
    if (!agent) throw new Error(`内核 "${kernel}" 不对应任何存活 agent，编排能力拒绝服务`)
    return agent
  }

  // 原子 effect：热重载 dispose 时整体摘除，避免半截泄漏（registerHostMethod 对重名 fail-loud）。
  ctx.effect(() => {
    const disposers = [
      ctx.ipython.registerHostMethod('subagent_spawn', async (args, kernel) => {
        const parent = callerAgent(kernel)
        const label = String(args[0] ?? 'kernel-spawned worker')
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label,
          request: {
            label,
            prompt: [{ type: 'text', text: String(args[1] ?? '') }],
            parent,
            agentOptions: { provider: 'kimi-coding', model: 'k3-256k' },
          },
          signal: new AbortController().signal,
        })
        return started.childId
      }),
      ctx.ipython.registerHostMethod('subagent_list', async (_args, kernel) => {
        const parent = callerAgent(kernel)
        const children = await ctx.subagents.listChildren(parent.id)
        return children.map((c) => (c.kind === 'child' ? { id: c.id, activity: c.activity, mode: c.mode } : { id: c.id }))
      }),
      ctx.ipython.registerHostMethod('subagent_send', async (args, kernel) => {
        const parent = callerAgent(kernel)
        return await ctx.subagents.followup(
          parent,
          String(args[0]) as SessionId,
          [{ type: 'text', text: String(args[1] ?? '') }],
          { source: { kind: 'user' }, signal: new AbortController().signal },
        )
      }),
    ]
    return () => { for (const d of disposers) d() }
  }, 'bridge-subagent: host methods')
}
