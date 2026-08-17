// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../registry.ts
import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Dict } from '@deepseek-ai/cosmokit'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils.ts'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

/**
 * 插件和 `@Inject` 装饰器接受的服务依赖声明。
 *
 * 数组形式：纯声明"我需要这些服务"，不带任何配置。对象形式：键是服务名，
 * 值是该服务在本插件上下文里的 intercept 配置（可选）——intercept 配置会
 * 并入服务解析出的 config，见 Context.intercept。
 */
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

/** 类型工具：筛出 Context 上"服务值带 symbols.config 类型标记"的键——只有这些服务支持类型化的 intercept 配置。 */
export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any
}

/**
 * 在类或类方法上声明服务依赖的装饰器。
 *
 * 用在类上：把依赖写进类的静态 `inject` 表，整个插件加载时生效。
 * 用在方法上：推迟这个方法的执行——声明的服务全部可用时才真正调用。
 *
 * @param name — 依赖的服务名。
 * @param config — 可选，该服务的 intercept 配置。
 * @returns 类装饰器或方法装饰器。
 */
export function Inject<K extends InjectKey>(name: K, config?: Context[K] extends { [symbols.config]: infer T } ? T : never) {
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    // 类装饰器：往类的静态 inject 表里加一条依赖。
    if (decorator.kind === 'class') {
      // 若类还没有自己的 inject（只有从父类继承来的），以原型上的 inject
      // 为原型新建一张表——子类加依赖不会污染父类。checkProto 标记告诉
      // Inject.resolve："这张表有原型链，归一化时要连祖先的一起展开"。
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(value, 'inject', Object.create(Object.getPrototypeOf(value).inject ?? null))
        defineProperty(value.inject, symbols.checkProto, true)
      }
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      // 方法装饰器：先把依赖记到方法自己的元数据里（此时还没有实例，
      // 更没有 ctx，没法真正起依赖监听）。
      const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null)
      inject[name] = config
      // 再注册一个实例初始化钩子：实例构造出来以后，把方法包装成"等服务
      // 齐了再执行"。ctx.inject 内部就是起一个迷你插件——依赖不可用时方法
      // 不会被调，依赖变化时自动重新调度。initHooks 由 fiber 在 new 完实例
      // 后统一执行（见 fiber.ts）。
      // property 是 tracker 元信息里 ctx 对应的字段名；有的话，调用时把
      // ctx 叠回实例上，让方法里的 this.ctx 指向包装后的上下文。
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            return value.call(property ? withProps(this, { [property]: ctx }) : this)
          })
        })
      })
    }
  }
}

/** inject 声明的归一化工具。 */
export namespace Inject {
  /**
   * 把数组 / 对象 / 类继承来的 inject 元数据统一拍平成一张普通映射表。
   *
   * @param inject — 待归一化的声明；`null`/`undefined` 表示不添加任何依赖。
   * @param result — 要填充的目标表（服务名 → intercept 配置，无配置为 `null`）。
   * @returns `result`。
   */
  export function resolve(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
    if (!inject) return result
    // 数组形式：只有名字，没有配置。
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = null
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      // 带 checkProto 标记的表来自 @Inject 类装饰器，原型链上挂着祖先的
      // 依赖：先递归展开原型（祖先的先入表，子类同名覆盖），再收自己的键。
      Object.assign(result, resolve(Object.getPrototypeOf(inject)))
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    } else {
      // 普通对象形式。
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    }
    return result
  }
}

/** 插件入口支持的三种形态。 */
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

/** 插件入口与运行时记录相关的类型。 */
export namespace Plugin {
  /** 插件注册表及相关工具共同认识的共享元数据。 */
  export interface Base<T = any> {
    /** 展示名：用于 fiber 的诊断信息和 logger 命名。 */
    name?: string
    /** 插件启动前用来校验 config 的 standard-schema 校验器。 */
    Config?: StandardSchemaV1<any, T>
    /** 插件依赖的服务：全部可用时插件才会加载；缺一个就停在等待状态。 */
    inject?: Inject
    /** 插件提供的服务名（`Service` 基类和加载器会读它）。 */
    provide?: string | string[]
    /** 插件声明自己要消费哪些服务的 intercept 配置。 */
    intercept?: Dict<boolean>
  }

  export interface Transform<S, T> {
    /** 判别字段：标记这个对象是"配置转换器"（schema 形态）。 */
    schema?: true
    /** 把面向用户的配置转成运行时配置。 */
    Config: (config: S) => T
  }

  /** 函数形态插件：以 `(ctx, config)` 调用。 */
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  /** 类形态插件：以 `new (ctx, config)` 构造。 */
  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  /** 对象形态插件：调用它的 `apply(ctx, config)` 方法。 */
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }

  /** 同一个插件回调的所有 fiber 共享的可变注册表记录。 */
  export interface Runtime {
    /** 展示名，取自第一次注册时的那个插件形态。 */
    name?: string
    /** 该插件当前所有活着的 fiber（每次 `ctx.plugin()` 调用产生一个）。 */
    fibers: DisposableList<Fiber>
    /** 所有 fiber 共享的可执行入口，也是注册表认插件用的身份键。 */
    callback: globalThis.Function
    /** 作用在每个 fiber 的 config 上的 standard-schema 校验器。 */
    Config?: StandardSchemaV1
  }
}

type Spread<T> = undefined extends T ? [config?: T] : [config: T]

type GetPluginParameters<P> =
  | P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

type GetPluginConfig<P> =
  | P extends Plugin.Transform<infer S, any>
  ? S
  : GetPluginParameters<P>[0]

declare module './context.ts' {
  export interface Context {
    /**
     * 等请求的服务全部可用后运行回调。
     *
     * 等价于 `ctx.plugin({ inject, apply: callback })` 的简写：任何一个依赖的
     * 服务变动时，回调都会被卸载并重新运行。
     *
     * @param deps — 依赖的服务，数组或"名字 → 配置"映射。
     * @param callback — 插件体，以 `(ctx, config)` 调用。
     * @returns fiber；await 它会在加载结束后落定。
     */
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
    /**
     * 在当前上下文里加载一个插件。
     *
     * @param plugin — 函数、类或带 `apply` 方法的对象，三种形态之一。
     * @param args — 插件配置，会先经过它的 `Config` schema 校验。
     * @returns fiber；await 它会在加载结束后落定
     * （配置或启动出错则以该错误 reject）。
     */
    plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
  }
}

/**
 * 插件注册表，安装为 `ctx.registry`，并把常用方法 mixin 到每个 ctx 上。
 *
 * 职责：识别并归一化插件的三种形态、维护插件运行时记录（runtime）、
 * 启动 fiber（插件的一次运行实例），以及提供类似 Map 的遍历接口。
 */
export class RegistryService {
  private _counter = 0
  // 注册表本体：插件回调 → 运行时记录。回调本身是身份键——同一个函数
  // 不管以哪种形态（函数本身 / 类 / 对象的 apply）注册多少次，都对应
  // 同一条记录。
  private _internal = new Map<Function, Plugin.Runtime>()

  // 打 tracker 标记：traceable 代理靠它认出"这是个服务"；property 声明
  // 服务身上哪个字段是 ctx（包装后会重绑定到调用方的上下文），noShadow
  // 表示保留影子链，服务内部仍能追到自己的真实出处。
  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })
  }

  /** 分配下一个 fiber 的 uid（每次读都自增）。 */
  get counter() {
    return ++this._counter
  }

  /** 已注册的插件 runtime 数量。 */
  get size() {
    return this._internal.size
  }

  /**
   * 把受支持的插件形态解析成它的可执行回调。
   *
   * @param plugin — 函数、类或带 `apply` 方法的对象。
   * @returns 标识该插件的回调。
   */
  resolve(plugin: Plugin): Function | undefined {
    if (typeof plugin === 'function') return plugin
    if (isApplicable(plugin)) return plugin.apply
  }

  /**
   * 查一个插件的运行时记录。
   *
   * @param plugin — 任意受支持的插件形态。
   * @returns 运行时记录；插件未注册时为 `undefined`。
   */
  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  /**
   * 判断一个插件是否注册过。
   *
   * @param plugin — 任意受支持的插件形态。
   * @returns 该插件至少存在一个 fiber 时为 `true`。
   */
  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  /**
   * 卸载一个插件的所有 fiber，并移除它的运行时记录。
   *
   * @param plugin — 任意受支持的插件形态。
   * @returns 被移除的运行时记录；没注册过则为 `undefined`。
   */
  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    // dispose 每个 fiber：触发它们各自的清理链（effect 注册的清理函数
    // 逆序执行），插件就此卸载。
    for (const fiber of runtime.fibers) {
      fiber.dispose()
    }
    return runtime
  }

  /** 遍历已注册的插件回调。 */
  keys() {
    return this._internal.keys()
  }

  /** 遍历已注册的插件运行时记录。 */
  values() {
    return this._internal.values()
  }

  /** 遍历 `[回调, 运行时记录]` 键值对。 */
  entries() {
    return this._internal.entries()
  }

  /**
   * 访问每条已注册的运行时记录。
   *
   * @param callback — 接收每条运行时记录和它的标识回调。
   */
  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  /**
   * 等请求的依赖可用后启动一个回调。
   *
   * @param inject — 依赖的服务，数组或"名字 → 配置"映射。
   * @param callback — 插件体，以 `(ctx, config)` 调用。
   * @returns fiber；await 它会在加载结束后落定。
   */
  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  /**
   * 在当前上下文里启动一个插件并返回它的 fiber。
   *
   * 先创建（或复用）插件的运行时记录，再在当前上下文之下启动一个新 fiber。
   *
   * @param plugin — 函数、类或带 `apply` 方法的对象。
   * @param config — 插件配置，会先经过它的 `Config` schema 校验。
   * @param getOuterStack — 捕获调用方的调用栈，供 effect 报错时拼接诊断信息。
   * @returns fiber；await 它会在加载结束后落定。
   */
  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // 解析出插件的可执行回调（函数本身 / 类 / 对象的 apply 方法）。
    const callback = this.resolve(plugin)

    // 同一回调重复 plugin() 只建一条 runtime 记录（callback 是身份键）；
    // 每次调用产生一个独立的 fiber 挂进 runtime.fibers。
    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      // 对象形态插件的方法名固定叫 apply，没有展示价值，抹掉。
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    // 创建 fiber（插件的运行实例）。Fiber 构造器里会完成依赖检查：
    // 依赖齐了才真正执行插件回调，不齐就停在 PENDING 等 notify 唤醒。
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
    // 包一层原型包装，让 fiber 可以 await：await ctx.plugin(...) 等价于
    // await fiber.await()——等加载（或失败）落定，启动错误在这里抛给调用方。
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
