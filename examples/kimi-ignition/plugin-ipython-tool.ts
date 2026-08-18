/**
 * plugin-ipython-tool —— 把持久 Python 内核递给模型：注册 `execute` 工具（agent 的"手"）。
 *
 * 内核本体在 plugin-ipython-daemon.py 独立进程（见 plugin-ipython-kernel.ts 的架构说明），
 * 本插件只做两件事：往 systemPrompt 挂一段内核使用说明 + 注册 execute 工具。
 * 热重载本插件只换工具注册与提示词，内核与变量不动。
 *
 * 多租户：默认内核 key = 调用方 agent 的 sessionId——主 agent 与每个 subagent 工人
 * 各自持有独立持久内核；args.kernel 可显式越界（主 agent  deliberately 摸工人的内核）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'plugin-ipython-tool'
export const inject = ['tools', 'systemPrompt', 'ipython']

/** 模型可见的内核使用说明（systemPrompt section）。 */
const IPYTHON_PROMPT = `你可以用 execute 工具在一个持久 Python 内核里运行代码（你的"手"）：
- 内核是持久的：变量、import、函数定义在多次调用之间一直存活，把工作拆成多步增量推进。
- 每个会话一个独立内核：你的内核与工人 agent 的内核互不可见。
- cell 语义：最后一个孤立表达式的值会作为 result 返回（等价 IPython 的 Out）；stdout/stderr 全量回传。
- 报错不是失败：异常以 error 字段返回，修改变量重试即可，内核状态仍在。
- 长任务会被超时打断：杀的是当前 cell，内核与已有变量存活，换个思路继续。
- 复杂的活先在内核里小步验证（自验证），确认可行再落到正式动作。`

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:execute', order: 120, text: IPYTHON_PROMPT })

  // host 反向桥的回环自检端点：内核里 host.echo(x) 应原样返回 x——
  // 桥本身的健康探针，也是后续注册编排类宿主方法（subagent 等）的协议样例。
  ctx.effect(() => ctx.ipython.registerHostMethod('echo', (args) => args[0] ?? null), 'ipython-tool: host echo')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'execute',
    description: '在持久 Python 内核里执行一段代码。变量/import/定义跨调用常驻；最后一条孤立表达式的值作为 result 返回；异常以 error 字段返回（内核与状态仍在）；超时/中断杀 cell 不杀内核。',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: '要在内核里执行的 Python 代码（一个 cell）。',
      },
      timeout_ms: {
        type: 'number',
        description: '本次执行的超时毫秒数（默认 120000）。超时发 interrupt 杀 cell，内核与变量保留。',
      },
      kernel: {
        type: 'string',
        description: '目标内核名。默认用你自己会话的独立内核；显式指定可触达其他会话的内核。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          result: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          error: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                  traceback: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
            required: true,
          },
        },
      },
      render: (_args, value) => {
        const parts: string[] = []
        if (value.stdout) parts.push(value.stdout)
        if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
        if (value.result !== null) parts.push(`Out: ${value.result}`)
        if (value.error) parts.push(`Error(${value.error.type}): ${value.error.message}`)
        return [{ type: 'text', text: parts.join('\n') || '(cell 执行完成，无输出)' }]
      },
    },
    timeoutMs: 130_000, // 略大于 exec 默认超时：让自己的 interrupt 语义先点火
    async execute(args, exec) {
      const kernel = args.kernel ?? exec.agent?.id ?? 'shared'
      return await ctx.ipython.exec(kernel, args.code, {
        ...args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {},
        signal: exec.signal,
      })
    },
  })), 'ipython-tool: execute')
}
