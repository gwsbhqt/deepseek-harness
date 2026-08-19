/** Machine-oriented stdin/stdout bridge for the self-evolution agent. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as readline from 'node:readline'

export const name = 'plugin-repl'
export const inject = ['agents']

/** Selects the agent session driven by stdin. */
export interface Config {
  sessionId: string
}

function record(fields: Record<string, unknown>): string {
  return `REPL ${JSON.stringify(fields)}\n`
}

/**
 * Projects one durable session event onto the prefixed JSON-line protocol.
 * @param event - Event from the configured agent session.
 * @returns One prefixed JSON line, or `undefined` when the event is not useful to automation.
 */
function formatReplEvent(event: SessionEvent): string | undefined {
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    if (!text) return undefined
    return record({
      type: 'assistant',
      turn: event.data.turn,
      step: event.data.step,
      text,
    })
  }

  if (event.type === 'turn/end') {
    const reason = event.data.reason
    const detail = reason.kind === 'error'
      ? reason.error.message
      : reason.kind === 'aborted'
        ? reason.reason.kind
        : undefined
    return record({
      type: 'turn',
      turn: event.data.turn,
      reason: reason.kind,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  return undefined
}

/**
 * Mounts the line-oriented bridge and releases stdin listeners on disposal.
 * @param ctx - Plugin context providing the agent registry and session events.
 * @param config - Stable session id of the target agent.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const input = readline.createInterface({ input: process.stdin, terminal: false })
    const write = (line: string): void => {
      process.stdout.write(line)
    }

    const offEvent = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== config.sessionId) return
      const line = formatReplEvent(event)
      if (line !== undefined) write(line)
    })

    input.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      const agent = ctx.agents.get(SessionId(config.sessionId))
      if (agent === undefined) {
        write(record({ type: 'error', code: 'AGENT_NOT_READY', sessionId: config.sessionId }))
        return
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    })

    write(record({ type: 'ready', sessionId: config.sessionId }))

    return () => {
      offEvent()
      input.close()
    }
  }, 'plugin-repl: stdin readline')
}
