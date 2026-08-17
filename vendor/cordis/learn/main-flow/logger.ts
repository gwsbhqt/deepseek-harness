// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../logger.ts
import { defineProperty, hyphenate } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { createCallable, joinPrototype, symbols, type Tracker } from './utils.ts'

// 声明合并：给 Context 的 Intercept 接口追加 logger 一项，
// 这样子上下文就能通过 intercept 机制覆盖日志服务的默认行为（默认日志名、级别）
declare module './context.ts' {
  interface Intercept {
    logger: LoggerService.Intercept
  }
}

/** 日志方法名，同时也是级别类别：error / info / warn / debug 四种。 */
export type LoggerType = 'error' | 'info' | 'warn' | 'debug'

/** 单个级别方法的可调用签名：第一个参数是格式串（或任意值），后面跟占位符的替换参数。 */
export type LoggerMethod = (format: any, ...param: any[]) => void

/** 占位符格式化器：把 printf 风格占位符（如 %s）对应的一个参数值渲染成输出内容。 */
export type Formatter = (value: any, exporter: Exporter, message: Message) => any

/** 数值级别：导出器用它决定一条消息要不要真正输出，数值越小越严重。 */
export const enum LoggerLevel {
  ERROR = 0,
  INFO = 1,
  WARN = 2,
  DEBUG = 3,
}

/** 交给导出器的结构化日志记录：一条日志的序号、时间戳、名字、级别、参数等全部信息。 */
export interface Message {
  sn: number
  ts: number
  name: string
  type: LoggerType
  level: number
  args: any[]
  fiber?: WeakRef<Fiber>
}

/**
 * 日志导出器：接收结构化日志的“出口”，比如写控制台、写文件、进缓冲区。
 * colors 声明支持的终端颜色深度（false 表示不着色），maxLength 限制单行长度，
 * levels 按日志名单独设级别阈值，formatters 覆盖内置的占位符格式化器。
 */
export interface Exporter {
  colors?: number | false
  maxLength?: number
  levels?: Record<string, number>
  formatters?: Record<string, Formatter>
  export(message: Message): void
}

/**
 * `Logger.format()` 内置的占位符格式化器表：
 * %s 转字符串，%d / %i 截断成整数，%f 转浮点数，%o / %O 转 JSON，
 * %c 输出空串（相当于吞掉这个参数），%C 输出按日志名哈希着色的名字。
 */
export const defaultFormatters: Record<string, Formatter> = {
  s: (value) => String(value),
  d: (value) => Math.trunc(Number(value)),
  i: (value) => Math.trunc(Number(value)),
  f: (value) => Number(value),
  o: (value) => JSON.stringify(value),
  O: (value) => JSON.stringify(value),
  c: () => '',
  C: (value, exporter, message) => {
    return Logger.color(exporter, Logger.code(message.name, exporter.colors), value)
  },
}

/** 创建一个命名 logger 门面时的选项。 */
export interface LoggerOptions {
  /** 日志名：会出现在本 logger 产出的每条消息上。 */
  name: string
  /** 会合并进本 logger 每条记录的附加字段。 */
  meta?: Partial<Message>
  /** 导出器自己没有级别阈值时，兜底使用的最高输出级别。 */
  level?: number
}

/** Logger 门面的身份部分：日志名、逐条继承的消息元数据，以及可选的输出级别上限。 */
export interface Logger extends LoggerOptions {}
/** Logger 门面的四个级别方法。 */
export interface Logger extends Record<LoggerType, LoggerMethod> {}

/** 面向使用者的日志门面：一个命名子系统一个实例，只负责收集参数、组装记录并分发给所有导出器。 */
export class Logger {
  /**
   * 给文本包一层 ANSI 转义序列，让它在终端里显示为彩色。
   * code < 8 用 16 色的 `3x` 前景色码，更大的编号用 256 色的 `38;5;n` 形式；
   * 导出器声明的颜色深度不够（colors 为假）时不加颜色，原样返回文本。
   */
  static color(exporter: Exporter, code: number, value: any, decoration = '') {
    if (!exporter.colors) return '' + value
    return `\u001b[3${code < 8 ? code : '8;5;' + code}${exporter.colors >= 2 ? decoration : ''}m${value}\u001b[0m`
  }

  /**
   * 把日志名哈希成一个确定的颜色编号：同一个名字永远得到同一个颜色，
   * 不同名字大概率不同颜色，方便在终端里一眼区分日志来源。
   * 哈希是逐字符的 `hash * 7 + 字符码 + 13`（`hash << 3` 即乘 8，减去自身即乘 7），
   * `hash |= 0` 把结果压回 32 位整数防止溢出成浮点数。
   */
  static code(name: string, level?: false | number) {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 3) - hash) + name.charCodeAt(i) + 13
      hash |= 0
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16
    return colors[Math.abs(hash) % colors.length]
  }

  /**
   * 把一条日志的原始参数渲染成最终字符串（printf 风格）。
   * 首参是 Error 时改用它的堆栈文本；首参不是字符串时视为没给格式串，
   * 整个参数列表按 %o 处理。逐个替换 %x 占位符后，没用完的参数追加到
   * 末尾，最后把超长的行截断到 maxLength。
   */
  static format(exporter: Exporter, message: Message): string {
    const args = message.args.slice()
    if (args[0] instanceof Error) {
      args[0] = args[0].stack
      args.unshift('%s')
    } else if (typeof args[0] !== 'string') {
      args.unshift('%o')
    }

    let format: string = args.shift()
    // 扫描格式串里的 %x 占位符：%% 转义成百分号；有对应格式化器就消费一个参数并渲染；
    // 都不认识就原样保留
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === '%%') return '%'
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char]
      if (typeof formatter === 'function') {
        const value = args.shift()
        return formatter(value, exporter, message)
      }
      return match
    })

    // 占位符没用完的参数逐个追加到行尾；对象先过一遍 %o 格式化器（默认转 JSON）
    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o
    for (let arg of args) {
      if (typeof arg === 'object' && arg) {
        arg = oFormatter(arg, exporter, message)
      }
      format += ' ' + arg
    }

    // 按行截断：任何一行超过 maxLength 就砍掉多余部分并补省略号
    const { maxLength = 10240 } = exporter
    return format.split(/\r?\n/g).map(line => {
      return line.slice(0, maxLength) + (line.length > maxLength ? '...' : '')
    }).join('\n')
  }

  constructor(options: LoggerOptions, private service: LoggerService) {
    // 把 name / meta / level 拷到实例上，再为四个级别各生成一个方法
    // （它们是挂在实例上的普通函数属性，可以被解构出来单独用）
    Object.assign(this, options)
    this.error = this._method('error', LoggerLevel.ERROR)
    this.info = this._method('info', LoggerLevel.INFO)
    this.warn = this._method('warn', LoggerLevel.WARN)
    this.debug = this._method('debug', LoggerLevel.DEBUG)
  }

  /**
   * 生成一个级别方法。每次调用时：
   * 1. 给消息编一个全服务递增的序号、打上时间戳；
   * 2. 分发给所有导出器，各自按级别阈值决定收不收（阈值查找顺序：
   *    按日志名单独配置 → default 配置 → 本 logger 的 level → 内建兜底 INFO）。
   */
  private _method(type: LoggerType, level: number): LoggerMethod {
    return (...args: any[]) => {
      const sn = ++this.service._snMessage
      const ts = Date.now()
      for (const exporter of this.service.exporters.values()) {
        const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? LoggerLevel.INFO
        if (targetLevel < level) continue
        const message: Message = { sn, ts, type, level, name: this.name, ...this.meta, args }
        exporter.export(message)
      }
    }
  }
}

/** ANSI 16 色模式下给日志名配色用的颜色编号表。 */
export const c16 = [6, 2, 3, 4, 5, 1]
/** ANSI 256 色模式下给日志名配色用的颜色编号表（更细的一档调色板）。 */
export const c256 = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62,
  63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113,
  129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168,
  169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
]

/** 日志服务的 intercept 配置：子上下文可通过它改默认日志名和输出级别。 */
export namespace LoggerService {
  export interface Intercept {
    name?: string
    level?: number
  }
}

/** `ctx.logger` 的可调用形态：既能当函数调（生成命名 logger），又自带四个级别方法。 */
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
}

/**
 * 内建的日志服务。
 *
 * 调用 `ctx.logger(name)` 得到一个命名 logger；也可以直接写
 * `ctx.logger.info(...)`，此时日志名自动取当前 fiber 的名字。
 */
export class LoggerService {
  // 环形缓冲区：默认导出器把消息攒在这里，只留最近 bufferSize 条，供事后回看
  bufferSize = 1000
  buffer: Message[] = []
  ctx!: Context

  // 两个递增序号：_snMessage 给消息编号，_snExporter 给导出器编号（兼作 Map 的键）
  _snMessage = 0
  _snExporter = 0
  exporters = new Map<number, Exporter>()

  constructor(ctx: Context) {
    // noShadow 表示本服务“认娘家”：即使被别的插件经代理使用，
    // 也要能顺着影子上下文找回自己最初所属的 fiber（invoke 里靠它取默认日志名）
    const tracker: Tracker = {
      property: 'ctx',
      noShadow: true,
    }
    // 把自己变成可调用的服务对象：造一个函数，缝上“本类原型 + Function.prototype”
    // 的原型链，再把本实例的自有属性全部拷过去；
    // 构造函数最后 return 的就是这个函数，所以 `ctx.logger` 拿到的也是它
    const self = createCallable('logger', joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker) as unknown as LoggerService
    Object.assign(self, this)
    self.ctx = ctx
    defineProperty(self, symbols.tracker, tracker)

    // 注册默认导出器：所有消息进环形缓冲区，超出容量就丢掉最旧的一段
    self.exporter({
      colors: 3,
      export: (message) => {
        self.buffer.push(message)
        if (self.buffer.length > self.bufferSize) {
          self.buffer = self.buffer.slice(-self.bufferSize)
        }
      },
    })

    return self
  }

  /**
   * 注册一个导出器，生命周期挂在当前 fiber 上：fiber 卸载时导出器自动移除。
   * 实现上走 ctx.effect ——注册时交出清理函数，框架保证卸载时执行。
   *
   * @param exporter — 接收结构化日志的出口对象。
   * @returns 注销函数：调用后立即移除该导出器。
   */
  exporter(exporter: Exporter) {
    return this.ctx.effect(() => {
      this.exporters.set(++this._snExporter, exporter)
      return () => this.exporters.delete(this._snExporter)
    }, 'ctx.logger.exporter()')
  }

  // 沿上下文的 intercept 原型链收集所有 logger 配置：根在前、叶子在后，
  // Object.assign 后者覆盖前者，于是越靠近当前上下文的配置优先级越高
  private _resolveConfig(): LoggerService.Intercept {
    let intercept = this.ctx[symbols.intercept]
    const configs: LoggerService.Intercept[] = []
    while ('logger' in intercept) {
      if (Object.hasOwn(intercept, 'logger')) {
        configs.unshift(intercept['logger'])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return Object.assign({}, ...configs)
  }

  // `ctx.logger(...)` 被调用时走到这里（可调用服务的调用体）：
  // 日志名优先级——显式参数 > intercept 配置 > 当前 fiber 名（转成连字符形式）；
  // 记录里用 WeakRef 挂住 fiber，日志缓冲不会因此阻止 fiber 被垃圾回收
  [symbols.invoke](name?: string): Logger {
    const config = this._resolveConfig()
    const fiber = ((this.ctx as any)[symbols.shadow] ?? this.ctx).fiber
    name ??= config.name
    name ??= hyphenate(fiber.name)
    return new Logger({
      name,
      level: config.level,
      meta: { fiber: new WeakRef(fiber) },
    }, this)
  }

  // 类初始化块：给原型补上 error / info / warn / debug 四个方法，
  // 内部先把自己当函数调用（得到以当前 fiber 命名的 logger），再转发到对应级别，
  // 于是 `ctx.logger.info(...)` 等价于 `ctx.logger().info(...)`
  static {
    for (const type of ['error', 'info', 'warn', 'debug'] as const) {
      ;(LoggerService.prototype as any)[type] = function (this: LoggerService, ...args: any[]) {
        return (this as any)()[type](...args)
      }
    }
  }
}
