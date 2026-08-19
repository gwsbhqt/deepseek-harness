/**
 * plugin-repl —— 自进化 Agent 的终端接入插件。
 *
 * 职责（唯一）：stdin 行 → main agent 的 followup 回合；session/event → stdout。
 * 脑（ReAct 循环）在 dsh-agent-loop，记忆（历史）在 dsh-session + jsonl 持久化，
 * 本插件不持有任何会话状态——热重载本插件只换"嘴皮"，agent 的思想与记忆不动。
 *
 * 渲染契约：四类内容一眼可分——
 *   用户输入：亮青底/青色 + "你 ›"
 *   助手正文：绿色 + "自进化 ›"
 *   工具调用：黄色 + "▸ 调用 <工具名>"，入参默认 3 行预览，超长以 "…(共N行)" 收尾
 *   工具结果：暗灰 + "◂ 结果 <工具名>"，出参同样折叠；isError 用红色
 */
import type { Context } from '@deepseek-ai/cordis'
import { MessageId, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as readline from 'node:readline'
import { randomUUID } from 'node:crypto'

export const name = 'plugin-repl'
export const inject = ['agents']

/** 插件配置：要驱动的 agent 的稳定会话 id（与 agent-loop config.agents 对应）。 */
export interface Config {
  sessionId: string
}

const PREVIEW_LINES = 3
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  black: '\u001b[30m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
  cyan: '\u001b[36m',
  brightCyan: '\u001b[96m',
  bgBrightCyan: '\u001b[106m',
}

function paint(color: keyof typeof C, text: string): string {
  return useColor ? `${C[color]}${text}${C.reset}` : text
}

function prettyMaybeJson(raw: string): string {
  const text = raw
  const trimmed = text.trim()
  if (!trimmed) return '(empty)'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return text
    }
  }
  return text
}

function collapseLines(text: string, max = PREVIEW_LINES): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return `${lines.slice(0, max).join('\n')}\n…(共${lines.length}行)`
}

function previewPayload(raw: string): string {
  return collapseLines(prettyMaybeJson(raw))
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n')
}

function blockText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string; content?: unknown[]; name?: string; arguments?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'reasoning' && typeof b.text === 'string') parts.push(paint('dim', `[思考] ${b.text}`))
    else if (b.type === 'tool-result' && Array.isArray(b.content)) parts.push(blockText(b.content))
    else if (b.type === 'tool-call') parts.push(`[tool-call ${b.name ?? '?'}] ${prettyMaybeJson(b.arguments ?? '')}`)
    else if (b.type === 'image') parts.push('[image]')
  }
  return parts.filter(Boolean).join('\n')
}

function messageText(message: Message): string {
  return blockText(message.content)
}

function userMsg(text: string): UserMessage {
  return {
    id: MessageId(randomUUID()),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 挂载 REPL。effect 返回卸载器：热重载时 cordis 自动执行，回收 stdin 监听器。
 * @param ctx - 插件上下文，需提供 `agents` 服务。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx: Context, config: Config) {
  ctx.effect(() => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    const write = (text: string) => process.stdout.write(text)
    const pendingTools = new Map<string, string>()
    let assistantOpen = false

    const userLabel = () => useColor
      ? `${C.bgBrightCyan}${C.black} 你 › ${C.reset}`
      : '你 ›'
    const agentLabel = () => paint('green', paint('bold', '自进化 ›'))
    const prompt = () => write(paint('brightCyan', 'self-evolution> '))
    const closeAssistant = () => {
      if (assistantOpen) {
        write(useColor ? `${C.reset}\n` : '\n')
        assistantOpen = false
      }
    }
    const openAssistant = () => {
      if (!assistantOpen) {
        write(`\n${agentLabel()} `)
        assistantOpen = true
      }
    }

    write(`${paint('green', 'self-evolution ready')} ${paint('dim', `(agent: ${config.sessionId})`)}\n`)
    prompt()

    const offEvent = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== config.sessionId) return

      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind === 'tool') return
        closeAssistant()
        if (source.kind === 'user') {
          write(`\n${userLabel()} ${paint('cyan', messageText(event.data))}\n`)
        } else {
          const label = source.kind === 'plugin' ? `系统/${source.plugin}` : `系统/${source.kind}`
          write(`\n${paint('gray', `${label} ›`)} ${paint('gray', messageText(event.data))}\n`)
        }
        return
      }

      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'block-start' && chunk.blockType === 'text') {
          closeAssistant()
          openAssistant()
          return
        }
        if (chunk.type === 'text-delta') {
          openAssistant()
          write(useColor ? `${C.green}${chunk.text}${C.reset}` : chunk.text)
          return
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'text') {
          closeAssistant()
          return
        }
        return
      }

      if (event.type === 'tool/call') {
        closeAssistant()
        const { callId, name, arguments: args } = event.data
        pendingTools.set(String(callId), name)
        write(`\n${paint('yellow', `▸ 调用 ${name}`)} ${paint('dim', `#${event.seq} ${String(callId)}`)}\n`)
        write(indent(previewPayload(args), paint('dim', '  入参 │ ')) + '\n')
        return
      }

      if (event.type === 'tool/result') {
        closeAssistant()
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId || event.data.message.source.callId)
        const name = pendingTools.get(callId) || 'unknown'
        pendingTools.delete(callId)
        const failed = Boolean(event.data.error) || Boolean(block.isError)
        const status = failed ? paint('red', ` ✗ ${event.data.error ? event.data.error.code : 'ERROR'}`) : ''
        const header = failed ? paint('red', `◂ 结果 ${name}`) : paint('gray', `◂ 结果 ${name}`)
        const out = blockText(block.content) || (event.data.meta === undefined ? '(empty)' : prettyMaybeJson(JSON.stringify(event.data.meta)))
        write(`\n${header}${status} ${paint('dim', `#${event.seq} ${callId}`)}\n`)
        write(indent(previewPayload(out), paint('dim', '  出参 │ ')) + '\n')
        return
      }

      if (event.type === 'turn/end') {
        closeAssistant()
        const reason = event.data.reason
        const detail = reason.kind === 'error' ? ` ${reason.error.message}` : reason.kind === 'aborted' ? ` ${reason.reason.kind}` : ''
        write(paint('dim', `· 回合 ${event.data.turn} 结束：${reason.kind}${detail} ·`) + '\n')
        prompt()
      }
    })

    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return void prompt()
      const agent = ctx.agents.get(SessionId(config.sessionId))
      if (!agent) {
        write(`${paint('red', '系统 › agent not ready yet')}\n`)
        prompt()
        return
      }
      agent.followup(userMsg(text))
    })

    return () => {
      offEvent()
      rl.close()
    }
  }, 'plugin-repl: stdin readline')
}
