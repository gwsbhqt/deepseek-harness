import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../plugin-repl.ts'

type SessionListener = (session: { id: string }, event: SessionEvent) => void

function render(events: readonly SessionEvent[]): string[] {
  const output: string[] = []
  let listener: SessionListener | undefined
  let dispose: (() => void) | undefined
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })

  try {
    const ctx = {
      agents: { get: () => undefined },
      effect: (mount: () => () => void) => {
        dispose = mount()
      },
      on: (_event: string, callback: SessionListener) => {
        listener = callback
        return () => {}
      },
    }
    apply(ctx as unknown as Context, { sessionId: 'self-evolution-main' })
    if (listener === undefined) throw new Error('REPL did not register its session listener')
    for (const event of events) listener({ id: 'self-evolution-main' }, event)
    return output
  } finally {
    dispose?.()
    stdout.mockRestore()
  }
}

describe('self-evolution REPL JSON-line protocol', () => {
  it('emits complete assistant text as one prefixed JSON record without reasoning', () => {
    const event: SessionEvent<'assistant/message'> = {
      type: 'assistant/message',
      seq: 12,
      time: 100,
      data: {
        turn: 7,
        step: 3,
        message: {
          id: MessageId('assistant-7-3'),
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hidden reasoning' },
            { type: 'text', text: 'line one\nline two' },
          ],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
      surfaceOp: 'append',
    }

    expect(render([event])).toEqual([
      'REPL {"type":"ready","sessionId":"self-evolution-main"}\n',
      'REPL {"type":"assistant","turn":7,"step":3,"text":"line one\\nline two"}\n',
    ])
  })

  it('suppresses assistant messages without user-visible text', () => {
    const event: SessionEvent<'assistant/message'> = {
      type: 'assistant/message',
      seq: 13,
      time: 101,
      data: {
        turn: 7,
        step: 4,
        message: {
          id: MessageId('assistant-7-4'),
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'hidden reasoning' }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
      surfaceOp: 'append',
    }

    expect(render([event])).toEqual([
      'REPL {"type":"ready","sessionId":"self-evolution-main"}\n',
    ])
  })

  it('emits a terminal turn record with structured failure detail', () => {
    const event: SessionEvent<'turn/end'> = {
      type: 'turn/end',
      seq: 14,
      time: 102,
      data: {
        turn: 7,
        reason: { kind: 'error', error: { code: 'BROKEN', message: 'provider failed' } },
      },
    }

    expect(render([event])).toEqual([
      'REPL {"type":"ready","sessionId":"self-evolution-main"}\n',
      'REPL {"type":"turn","turn":7,"reason":"error","detail":"provider failed"}\n',
    ])
  })
})
