// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../../src/events.ts
import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Promisify } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { Fiber, FiberState } from './fiber.ts'
import { DisposableList, symbols } from './utils.ts'

/**
 * 判断监听器的返回值算不算"拦截成功"（bail：提前截停派发）。
 *
 * 约定只有 `null`、`false`、`undefined` 三种值表示"不拦截，继续往下传"，
 * 其余任何返回值都视为拦截值，会终止本次 bail 式派发并作为结果返回。
 *
 * @param value — 某个监听器的返回值。
 * @returns 除 `null`/`false`/`undefined` 外一律返回 `true`。
 */
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

/** 从函数类型里抽出参数列表（元组形式）。 */
export type Parameters<F> = F extends (...args: infer P) => any ? P : never
/** 从函数类型里抽出返回值类型。 */
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
/** 从函数类型里抽出显式声明的 `this` 类型。 */
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never

/**
 * 事件服务的五种派发策略。
 *
 * `emit`：同步挨个调用监听器，不等待任何异步结果；`parallel`：并发启动
 * 所有监听器并等它们全部落定；`serial`：按顺序逐个 await，直到有人返回
 * 拦截值；`bail`：同步按顺序调用，遇到第一个拦截值就停；`waterfall`：
 * 洋葱模型——监听器一层层包住最后一个 `next` 回调，调 `next()` 才继续
 * 往里走。
 */
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

// 声明合并（declaration merging）：这里再次声明同名的 Context 接口，
// TypeScript 会把这些成员"补"到 context.ts 的 Context 接口上——这样
// `ctx.emit(...)`、`ctx.on(...)` 等调用才有类型提示，而真正的实现
// 仍在本文件的 EventsService 里。
declare module './context.ts' {
  export interface Context {
    /* eslint-disable max-len */
    /**
     * 派发事件：并发运行所有监听器。
     *
     * @param name — 事件名。
     * @param args — 原样传给每个监听器的参数。
     * @returns 一个 promise，等全部监听器落定（无论成败）后完成。
     */
    parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
    /** 同上，但第一个参数显式指定监听器的 `this`（派发时也会用它做上下文过滤）。 */
    parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
    /**
     * 同步派发事件：挨个调用监听器，忽略一切返回值。
     *
     * 监听器返回的 promise 不会被等待，其中的异步错误也不会在这里抛出。
     *
     * @param name — 事件名。
     * @param args — 原样传给每个监听器的参数。
     */
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    /** 同上，但第一个参数显式指定监听器的 `this`（派发时也会用它做上下文过滤）。 */
    emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
    /**
     * 派发事件：按注册顺序逐个 await 监听器，直到有人返回拦截值。
     *
     * @param name — 事件名。
     * @param args — 原样传给每个监听器的参数。
     * @returns 第一个拦截值（非 null、非 false、非 undefined）；没人拦截则为 undefined。
     */
    serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    /** 同上，但第一个参数显式指定监听器的 `this`（派发时也会用它做上下文过滤）。 */
    serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    /**
     * 派发事件：同步按顺序调用监听器，遇到第一个拦截值立即停。
     *
     * @param name — 事件名。
     * @param args — 原样传给每个监听器的参数。
     * @returns 第一个拦截值（非 null、非 false、非 undefined）；没人拦截则为 undefined。
     */
    bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /** 同上，但第一个参数显式指定监听器的 `this`（派发时也会用它做上下文过滤）。 */
    bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /**
     * 以"洋葱模型"派发事件：事件的最后一个参数是 `next` 续体
     * （continuation，即"剩下的流程"）。
     *
     * 每个监听器都像一层洋葱皮包住后面的链：调用 `next()` 才会触发下一个
     * 监听器（最里层是内建默认行为）；不调 `next()` 就等于一票否决，
     * 内层全部跳过。
     *
     * @param name — 事件名。
     * @param args — 监听器参数，最后一个是最内层的 `next`。
     * @returns 最外层监听器的返回值。
     */
    waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /** 同上，但第一个参数显式指定监听器的 `this`（派发时也会用它做上下文过滤）。 */
    waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /**
     * 注册一个事件监听器，归属当前 fiber（插件卸载时自动摘除）。
     *
     * @param name — 要监听的事件名。
     * @param listener — 事件派发时被调用，收到派发参数。
     * @param options — 监听选项；直接传布尔值等价于 `{ prepend }`。
     * @returns 一个清理函数：调用它摘除监听器，返回 `true` 表示摘除前它还在册。
     */
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /**
     * 同 `on()`，但监听器第一次被触发后自动摘除，最多执行一次。
     *
     * @param name — 要监听的事件名。
     * @param listener — 最多被调用一次，收到派发参数。
     * @param options — 监听选项；直接传布尔值等价于 `{ prepend }`。
     * @returns 一个清理函数：调用它摘除监听器，返回 `true` 表示摘除前它还在册。
     */
    once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /* eslint-enable max-len */
  }
}

/** `ctx.on()` 和 `ctx.once()` 接受的选项。 */
export interface EventOptions {
  /** 把监听器插到同事件已有监听器的前面（先执行）。 */
  prepend?: boolean
  /** 全局监听器：无视上下文过滤器（`Context.filter`）的检查，一律收到事件。 */
  global?: boolean
}

/** 事件服务内部保存的一条监听器登记记录。 */
export interface Hook extends EventOptions {
  /** 注册该监听器的上下文；派发时按它做上下文过滤。 */
  ctx: Context
  /** 监听器本体。 */
  callback: (...args: any[]) => any
}

/**
 * 事件总线：安装为 `ctx.events`，其方法同时混入每个上下文
 * （所以能直接写 `ctx.on`、`ctx.emit` 等）。
 *
 * 支持 parallel / emit / serial / bail / waterfall 五种派发模式；
 * 每个监听器都归属注册它的 fiber，fiber 卸载时监听器随之自动摘除。
 */
export class EventsService {
  _hooks: Record<keyof any, Hook[]> = {}

  constructor(private ctx: Context) {
    // 给本服务挂上 traceable 元数据（utils.ts 的归因机制会读它）：
    // `property: 'ctx'` 声明"通过 ctx 属性拿到所属上下文"，`noShadow`
    // 表示包装成 traceable 代理时保留影子上下文——这样按来源归因的信息
    // （比如 logger 按来源 fiber 推导日志名）不会在代理层被抹掉。
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    // 注册拦截：internal/listener 在"有人注册监听器"时触发（见 on()）。
    // 这里把对 internal/update 的普通（非 global）注册改道——不放进全局
    // 监听器表，而是存进该 fiber 自己的 DisposableList。好处是：配置更新
    // 钩子跟着 fiber 走，fiber 卸载时随 DisposableList 一起自动清空。
    // 返回值非空即表示"注册已被接管"，on() 会直接把它交还给调用方。
    this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'internal/update' && !options.global) {
        const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
        const method = options.prepend ? 'unshift' : 'push'
        return hooks[method](listener)
      }
    })

    // 上面把钩子存进了 fiber 私有列表，这里负责把它们接回派发链：
    // 全局 + 插前的 internal/update 监听器，把私有列表里的钩子按序排在
    // waterfall 链的最前面，最后一个钩子调 next() 时才轮到框架内建的
    // 更新逻辑。global 保证不受上下文过滤影响，prepend 保证最先执行。
    this.on('internal/update', function (config, noSave, next) {
      const cbs = [...this._hooks['internal/update'] || []]
      const _next = () => {
        const cb = cbs.shift() ?? next
        return cb.call(this, config, noSave, _next)
      }
      return _next()
    }, { global: true, prepend: true })
  }

  /**
   * 一次派发的"听众解析"：挑出本次该执行的监听器，并按上下文过滤。
   *
   * 做法：第一个参数是对象/函数时视为显式 `this` 取出；再取出事件名；
   * 非 internal/ 事件先广播 internal/dispatch 供诊断；最后用该 `this`
   * 上挂的过滤器（`Context.filter`）筛掉不该收到的监听器（global
   * 监听器豁免），把幸存回调绑定到该 `this` 后返回。
   *
   * @param type — 派发模式，仅用于 internal/dispatch 诊断上报。
   * @param args — 原始派发参数；本方法会逐个 shift 消费到事件名为止。
   * @returns 过滤后、已绑定 `this` 的监听器回调列表。
   */
  dispatch(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string = args.shift()
    if (!name.startsWith('internal/')) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    const filter = thisArg?.[Context.filter]
    return (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
      .map(hook => hook.callback.bind(thisArg))
  }

  /**
   * 并发启动所有监听器，并等待全部落定。
   *
   * 用 Promise.allSettled 保证一个监听器失败不影响其他人执行；
   * 全部结束后若存在失败，把所有错误聚成一个 AggregateError 抛出。
   *
   * @param args — 可选的 `this`、事件名，然后是监听器参数。
   * @returns 全部监听器落定后完成的 promise。
   */
  async parallel(...args: any[]) {
    const results = await Promise.allSettled(this.dispatch('emit', args).map(async cb => cb(...args)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(error => error.reason))
  }

  /**
   * 同步执行所有监听器：不 await，返回值（包括 promise）直接丢弃。
   *
   * @param args — 可选的 `this`、事件名，然后是监听器参数。
   */
  emit(...args: any[]) {
    this.dispatch('emit', args).map(cb => cb(...args))
  }

  /**
   * 按顺序逐个 await 监听器，直到有人返回拦截值。
   *
   * @param args — 可选的 `this`、事件名，然后是监听器参数。
   * @returns 第一个拦截值（判定见 {@link isBailed}）；没人拦截则为 undefined。
   */
  async serial(...args: any[]) {
    for (const cb of this.dispatch('serial', args)) {
      const result = await cb(...args)
      if (isBailed(result)) return result
    }
  }

  /**
   * serial 的同步版：不 await，按顺序调用，遇第一个拦截值立即停。
   *
   * @param args — 可选的 `this`、事件名，然后是监听器参数。
   * @returns 第一个拦截值（判定见 {@link isBailed}）；没人拦截则为 undefined。
   */
  bail(...args: any[]) {
    for (const cb of this.dispatch('bail', args)) {
      const result = cb(...args)
      if (isBailed(result)) return result
    }
  }

  /**
   * 洋葱模型派发：把监听器一层层包在最后的 `next` 回调外面。
   *
   * 约定派发参数的最后一个是最内层 `next`（通常是框架内建行为）。
   * 监听器从外到内执行，每层拿到的 `next` 指向下一层；某层不调
   * `next()`，其内侧的全部环节（含内建行为）都被否决。实现是一个小
   * 状态机：每调一次 next() 就从队列头取一个监听器执行，取空了才轮到
   * 最内层 next。
   *
   * @param args — 可选的 `this`、事件名、监听器参数，最后是 `next`。
   * @returns 最外层监听器的返回值。
   */
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }

  /**
   * 把一条监听器记录登记为当前 fiber 的 effect——"监听器跟随插件
   * 自动清理"就靠这一步：effect 体先把监听器加进列表，再交出清理
   * 函数；fiber 卸载时框架逆序执行所有清理函数，监听器即被摘除。
   *
   * @param label — 在 fiber 诊断信息里显示的 effect 标签。
   * @param hooks — 该事件的监听器列表。
   * @param callback — 要登记的监听器。
   * @param options — 插前/插后与过滤选项。
   * @returns 手动摘除该监听器的清理函数。
   */
  register(label: string, hooks: Hook[], callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(hooks, callback)
    }, label)
  }

  /**
   * 从监听器列表中移除一条记录。
   *
   * @param hooks — 该事件的监听器列表。
   * @param callback — 要移除的监听器。
   * @returns 找到并移除则返回 `true`。
   */
  unregister(hooks: Hook[], callback: any) {
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  /**
   * 注册一个归属当前 fiber 的事件监听器，fiber 卸载时自动摘除。
   *
   * @param name — 要监听的事件名。
   * @param listener — 事件派发时被调用，收到派发参数。
   * @param options — 监听选项；直接传布尔值等价于 `{ prepend }`。
   * @returns 一个清理函数：调用它摘除监听器，返回 `true` 表示摘除前它还在册。
   */
  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // 处理特殊事件：先用 bail 派发 internal/listener，给核心服务一个
    // "接管本次注册"的机会（比如构造函数里把 internal/update 改道到
    // fiber 私有列表）；有人接管就直接把它的返回值交还给调用方。
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, hooks, listener, options)
  }

  /**
   * 注册一个"一次性"监听器：第一次触发后自动摘除。
   *
   * 实现很取巧：包一层壳函数，壳里先调 dispose() 摘掉自己，再转发给
   * 真正的监听器——即使真正的监听器抛错，摘除也已发生，保证"最多一次"。
   *
   * @param name — 要监听的事件名。
   * @param listener — 最多被调用一次，收到派发参数。
   * @param options — 监听选项；直接传布尔值等价于 `{ prepend }`。
   * @returns 一个清理函数：调用它摘除监听器，返回 `true` 表示摘除前它还在册。
   */
  once(name: string, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }
}

/**
 * 框架内建事件清单：供核心服务和扩展点使用；插件也可以通过声明合并
 * 往里加自己的事件，从而获得 `ctx.on` 等调用的类型提示。
 *
 * 大致分四类：plugin/status 跟踪 fiber 生命周期；service 观察依赖注册；
 * update/get/set/listener 让核心服务能拦截运行时的关键操作；
 * internal/dispatch 在事件投递前暴露总线诊断信息。
 */
export interface Events {
  /** 插件 fiber 被创建，或销毁时 uid 被清空，都会触发本事件。 */
  'internal/plugin'(fiber: Fiber): void
  /** fiber 的生命周期状态发生迁移；参数带上 fiber 本体和迁移前的旧状态。 */
  'internal/status'(fiber: Fiber, oldValue: FiberState): void
  /**
   * 在 fiber 声明的注入（inject 的依赖服务）就位之后，解析本次激活的原始插件配置。
   * @param config - 本次激活的原始配置。
   * @mode waterfall（洋葱模型：监听器须调 next() 才会继续）。
   */
  'internal/config'(this: Fiber, config: any, next: () => any): any
  /** 服务绑定时的拦截钩子；框架核心自己不触发，纯留给扩展使用。 */
  'internal/service'(this: Context, name: string, value: any): void
  /** waterfall：某 fiber 的配置更新即将生效；不调 `next()` 即可否决这次更新。 */
  'internal/update'(this: Fiber, config: any, noSave: boolean, next: () => void | Promise<void>): void | Promise<void>
  /** waterfall：正通过 context 代理读取一个服务。 */
  'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any
  /** waterfall：正通过 context 代理写入一个服务。 */
  'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean
  /** bail：正在注册一个监听器；任何非空返回值都会取代默认注册流程（由钩子接管）。 */
  'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void
  /** 有事件即将派发给监听器（仅对非 internal/ 的公开事件触发，避免总线自激）。 */
  'internal/dispatch'(mode: DispatchMode, name: string, args: any[], thisArg: any): void
}
