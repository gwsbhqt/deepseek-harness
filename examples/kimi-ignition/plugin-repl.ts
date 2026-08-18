/**
 * plugin-repl —— 点火仪式的终端接入插件，agent 的"嘴"。
 *
 * 职责（唯一）：stdin 行 → main agent 的 followup 回合；session/event → stdout。
 * 脑（ReAct 循环）在 dsh-agent-loop，记忆（历史）在 dsh-session + jsonl 持久化，
 * 本插件不持有任何会话状态——热重载本插件只换"嘴皮"，agent 的思想与记忆不动。
 *
 * 渲染的会话事件：assistant/chunk（text-delta 实时打印）、tool/result（一行标记）、
 * turn/end（回合结束，重新打印提示符）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as readline from 'node:readline'
import { randomUUID } from 'node:crypto'

export const name = 'plugin-repl'
export const inject = ['agents']

/** 插件配置：要驱动的 agent 的稳定会话 id（与 agent-loop config.agents 对应）。 */
export interface Config {
  sessionId: string
}

function userMsg(text: string): Message {
  return {
    id: randomUUID() as Message['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as Message
}

/**
 * 挂载 REPL。effect 返回卸载器：热重载时 cordis 自动执行，回收 stdin 监听器。
 * @param ctx - 插件上下文，需提供 `agents` 服务。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx: Context, config: Config) {
  ctx.effect(() => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    process.stdout.write(`kimi-ignition ready (agent: ${config.sessionId})\nkimi> `)

    const offEvent = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== config.sessionId) return
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
      } else if (event.type === 'tool/result') {
        const label = event.data.error ? `ERROR ${event.data.error.code}` : 'ok'
        process.stdout.write(`\n[tool result #${event.seq}: ${label}]\n`)
      } else if (event.type === 'turn/end') {
        process.stdout.write('\nkimi> ')
      }
    })

    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return void process.stdout.write('kimi> ')
      const agent = ctx.agents.get(config.sessionId as never)
      if (!agent) {
        process.stdout.write('[agent not ready yet]\nkimi> ')
        return
      }
      agent.followup(userMsg(text) as never)
    })

    return () => {
      offEvent()
      rl.close()
    }
  }, 'plugin-repl: stdin readline')
}
