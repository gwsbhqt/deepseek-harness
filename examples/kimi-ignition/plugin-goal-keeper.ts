/**
 * plugin-goal-keeper —— 目标守夜人：宿主重启后自动重新武装指定会话的活动目标。
 *
 * 背景：dsh-goal 的 activation 是进程内状态——agent/session-start 事件会把
 * 重启恢复的目标置为 disarmed（续跑授权默认不交还给新进程），
 * goal-round-driver 只驱动 armed 目标 ⇒ 任何宿主重启都会让自驱动回路停转。
 * 本插件是点火实验室的自主化补丁：挂载 2 秒后检查目标标会话，
 * 若目标 active 且 disarmed 则 resume（重新武装），让自循环跨重启存活。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const name = 'plugin-goal-keeper'
export const inject = ['agents', 'goals']

/** 插件配置：要看守的 agent 会话 id（与 agent-loop config.agents 对应）。 */
export interface Config {
  sessionId: string
}

export const Config: z<Config> = z.object({
  sessionId: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    // 2 秒延迟：让 GoalService 自己的 session-start 撤防监听先落定，再判断是否补防。
    const timer = setTimeout(() => {
      const agent = ctx.agents.get(config.sessionId as SessionId)
      if (!agent) return
      const goal = ctx.goals.get(agent)
      if (goal && goal.phase === 'active' && goal.activation === 'disarmed') {
        ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
        ctx.logger.info(`goal-keeper: 目标 ${goal.id} 已重新武装（第 ${goal.revision} 版）`)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, 'goal-keeper: rearm timer')
}
