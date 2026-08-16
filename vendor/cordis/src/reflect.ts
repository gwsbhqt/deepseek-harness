import { defineProperty, isNullable } from '@deepseek-ai/cosmokit'
import type { Dict } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { getTraceable, symbols, withProps } from './utils.ts'
import { Fiber, FiberState } from './fiber.ts'

declare module './context.ts' {
  interface Context {
    /**
     * 从服务仓库里读取一个服务，不要求调用方在 inject 里声明过它。
     *
     * 与直接写 `ctx.foo` 的区别：属性访问会走 Proxy 的 get 陷阱，没声明
     * inject 就访问会抛错；`ctx.get()` 是"静默读取"，拿不到就返回
     * `undefined`，适合"有就用、没有就跳过"的场景。
     *
     * @param name — 服务名。
     * @param strict — 为 `true`（默认）时，只有当提供该服务的 fiber 正处于
     * ACTIVE（已加载完成）状态才返回它的实现；传 `false` 则连加载中、
     * 未就绪的实现也能拿到。
     * @returns 服务实例；还没人提供（或 strict 模式下未就绪）时返回 `undefined`。
     */
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
    /** 同上，面向不在 Context 类型声明里的服务名（放弃类型检查，返回 any）。 */
    get(name: string, strict?: boolean): any
    /**
     * 覆盖一个已提供服务的值。
     *
     * 只有当初 provide 这个服务的那个 fiber 有权改它——防止一个插件偷偷
     * 替换掉别人的服务。对一个从没被提供过的名字赋值会直接抛错。
     *
     * @param name — 服务名。
     * @param value — 新的服务值。
     */
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
    /** 同上，面向不在 Context 类型声明里的服务名。 */
    set(name: string, value: any): void
    /**
     * 把当前 fiber 拥有的一个服务实现注册进容器。
     *
     * 注册后，同一隔离作用域（isolate scope，见 Context.isolate）里的依赖方
     * 在本 fiber 进入 ACTIVE 状态时就能读到它。当返回的清理函数执行、或本
     * fiber 卸载时，服务被注销并唤醒依赖方重新评估（依赖没了，依赖方可能
     * 因此跟着卸载）。若这个名字在本作用域已被提供、或已被声明为 accessor
     * （计算属性），抛错。
     *
     * @param name — 服务名。
     * @param value — 服务值。
     * @returns 清理函数，调用它即注销该服务。
     */
    provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    /** 同上，面向不在 Context 类型声明里的服务名。 */
    provide(name: string, value?: any): () => void
    /**
     * 定义一个"计算属性"：读它时调用 get 钩子算出值，写它时调用可选的
     * set 钩子。类似 JS 对象上的 getter/setter，只是定义在 Context 这一层。
     *
     * 当前 fiber 卸载时，这个属性定义被自动移除。名字已被声明（无论已声明为
     * 服务还是别的 accessor）时抛错。
     *
     * @param name — 上下文属性名。
     * @param options — `get` 钩子和可选的 `set` 钩子。
     */
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
    /**
     * 把某个服务的部分成员"平铺"到 `ctx` 上，让 `ctx` 看上去自己就有这些
     * 方法。
     *
     * 每个被混入的键变成一个转发用的 accessor：读到它时转发给背后的服务
     * （方法还会 bind 到该服务上），所以 `ctx.on(...)` 实际调的是
     * `ctx.events.on(...)`。当前 fiber 卸载时这些混入全部移除。
     *
     * @param name — 持有源服务的上下文属性名。
     * @param mixins — 要转发的键列表，或"源键 → ctx 键"的映射（转发时可改名）。
     */
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    /** 同上，但第一个参数直接给源对象，而不是上下文属性名。 */
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

// 修错误栈：把栈顶前两行（消息行 + 最顶上一帧）替换成消息行，等于裁掉
// 一帧。那帧是框架内部的 Proxy 陷阱代码，对插件作者没意义；裁掉后报错栈
// 从调用方的业务代码开始，一眼能看出是谁在访问不存在的属性。
function enhanceError(error: Error) {
  const lines = error.stack!.split('\n')
  lines.splice(0, 2, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

const RESERVED_WORDS = ['prototype', 'then']

// 以下四类属性名算"特殊属性"：读写时走对象自身的常规语义，不做服务解析。
// - 是 symbol（框架内部的符号键，如 symbols.isolate）
// - 是保留字（prototype、then——then 必须排除，否则 await ctx 时 JS 引擎
//   读取 ctx.then 会被误判成"取一个名叫 then 的服务"）
// - 是数字字符串（'0'、'1'……数组下标式访问）
// - 以下划线开头（约定为私有字段，如 fiber 的 _disposables）
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return typeof prop === 'symbol'
    || RESERVED_WORDS.includes(prop)
    || parseInt(prop).toString() === prop
    || prop.startsWith('_')
}

/** 反射服务认识的上下文属性定义：要么是服务，要么是计算属性。 */
export type Property = Property.Service | Property.Accessor

/** `ReflectService` 支持的两种属性定义。 */
export namespace Property {
  /** 由 provide 注册的具体实现来支撑的服务属性。 */
  export interface Service {
    /** 判别字段：联合类型里靠 `type` 区分是哪种变体。 */
    type: 'service'
  }

  /** 由自定义 get/set 钩子支撑的计算属性。 */
  export interface Accessor {
    /** 判别字段。 */
    type: 'accessor'
    /** 计算属性值；`error` 是预造的错误对象，装着调用方的调用栈，供诊断报错用。 */
    get: (this: Context, receiver: any, error: Error) => any
    /** 可选的写钩子；返回 `false` 表示拒绝这次写入。 */
    set?: (this: Context, value: any, receiver: any, error: Error) => boolean
  }
}

/** 存放在根 reflect 服务里的一份具体服务实现记录。 */
export interface Impl {
  /** 服务名。 */
  name: string
  /** 提供该服务的 fiber（它拥有这份实现的生命周期：fiber 卸载，服务就没了）。 */
  fiber: Fiber
  /** 当前的服务值。 */
  value?: any
  /** 可选的可用性检查：依赖方被允许加载前，会先问它"现在真的能用吗"。 */
  check?: () => boolean
}

/**
 * 反射与服务解析层，安装为 `ctx.reflect`。
 *
 * 它是整个 Context 体系的引擎：ctx 上的属性读写（Proxy 陷阱）、服务的
 * 注册与查找、计算属性（accessor）、把核心服务方法平铺到 ctx 上的混入
 * （mixin），全部由它驱动。
 */
export class ReflectService {
  /** Proxy 陷阱集合：每个 context 对象的读、写、`in` 判断都经过这里做服务解析。 */
  static handler: ProxyHandler<Context> = {
    // get 陷阱：读 ctx.xxx 时触发。解析分三层，按顺序尝试：
    // 1. 特殊属性（symbol / 保留字 / 数字 / 下划线开头）→ 当普通属性读；
    // 2. 对象自身（含原型链）真实拥有的属性（如构造器里赋值的 this.reflect）
    //    → 读出后包一层 traceable 代理，让"谁在用这个服务"能归因到调用方插件；
    // 3. 都不是 → 进入服务解析：先查 accessor 定义，再沿 fiber 链查服务仓库。
    get: (target, prop, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      // 预造一个错误对象备用。此刻调用栈最干净（还在业务代码那一层），
      // 后面无论哪条分支失败都抛它，报错才能指到插件自己的代码行。
      const error = new Error(`cannot get property "${prop}" without inject`)

      try {
        // 第三层之一：这个名字被声明为计算属性 → 调它的 get 钩子算值。
        // receiver 用于 mixin 转发场景：让钩子知道这次访问是经由谁转发的。
        const def = target.reflect.props[prop]
        if (def?.type === 'accessor') {
          return def.get.call(ctx, ctx[symbols.receiver], error)
        }

        // 根 fiber（没有 runtime）说明框架还在启动阶段：不做 inject 检查，
        // 直接从仓库里捞，拿不到就是 undefined。
        if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)
        // internal/get 是 waterfall 事件：其他插件可以监听它来拦截、改写服务
        // 解析（比如测试时替换实现）。没有监听器时就执行末尾这个默认解析函数。
        return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
          // 默认解析：沿 fiber 祖先链向上找实现。
          // isolate 表把每个服务名映射成一个"隔离标签"（symbol）；只有标签相同
          // 的上下文才共享同一份实现——这就是 Context.isolate() 划出的作用域边界。
          const key = target[symbols.isolate][prop]
          // 带 shadow 的 ctx 是 traceable 代理造出的"影子上下文"，解析要回到影子
          // 背后那个真实 ctx 的 fiber 上开始。
          let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber
          // 沿 fiber 链向上爬：先看本 fiber 的 store（它依赖的服务 + 它提供的
          // 服务的快照）；没有就爬向父 fiber，每爬一层都要先确认没越过边界。
          while (true) {
            const impl = fiber.store?.[prop]
            if (impl) return getTraceable(ctx, impl.value)
            // 本 fiber 在 inject 里声明过这个服务、store 里却没有，说明它正停在
            // PENDING 等依赖。此时有人来访问属框架内部的误用，换成更明确的报错。
            if (prop in fiber.inject) {
              error.message = `cannot get required service "${prop}" in inactive context`
              throw error
            }
            // 一路爬到根 fiber 都没找到 → 抛"没声明 inject"。
            if (!fiber.runtime) throw error
            // 父级作用域里这个名字的隔离标签不一样 → 服务在祖先那边属于另一个
            // 作用域，不许越界读取 → 抛错。
            if (fiber.parent[symbols.isolate][prop] !== key) throw error
            fiber = fiber.parent.fiber
          }
        })
      // 只有我们预造的那个 error 需要修栈（裁掉框架内部帧）；别的异常
      // （比如 accessor 钩子自己抛的）原样上抛。
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    // set 陷阱：写 ctx.xxx 时触发。基本规矩：想写一个名字，必须先有人
    // 用 provide/accessor 声明过它——把服务容器和普通对象属性区分开，
    // 插件随手往 ctx 上塞东西会被拦下来报错。
    set: (target, prop, value, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const error = new Error(`cannot set property "${prop}" without provide`)
      // 没声明过的名字：根 fiber（框架启动期）允许当普通属性写（构造器
      // 初始化 this.reflect 等字段走的就是这条路）；插件运行期一律报错。
      const def = target.reflect.props[prop]
      if (!def) {
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
        throw enhanceError(error)
      }

      try {
        // 计算属性：交给它的 set 钩子；没定义 set 就是只读，返回 false
        // （严格模式下 Proxy 会因此抛 TypeError）。
        if (def.type === 'accessor') {
          if (!def.set) return false
          return def.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        // 服务属性：同样先经过 internal/set 这个 waterfall 拦截点，
        // 默认行为委托给 reflect.set（里面有"只有提供方本人能改"的权限检查）。
        return ctx.events.waterfall('internal/set', ctx, prop, value, error, () => {
          return ctx.reflect.set(prop, value, error)
        })
      // 同上：只修预造 error 的栈。
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    // has 陷阱：xxx in ctx 判断时触发。对象真实拥有的属性算有；在
    // reflect.props 里声明过的名字（服务或 accessor）也算有——哪怕服务还
    // 没提供值。这样 events in ctx 之类的能力探测才能正常工作。
    has: (target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target.reflect.props[prop]
    },
  }

  /** 服务实现表：键是隔离标签（symbol），同一标签的作用域共享同一份实现。 */
  public store: Dict<Impl, symbol> = Object.create(null)
  /** 已声明的上下文属性表：键是属性名，值是服务或 accessor 的定义。 */
  public props: Dict<Property> = Object.create(null)

  // 构造器做两件事：
  // 1. 给服务自身打 tracker 标记——traceable 代理（utils.ts）靠它认出
  //    "这是个服务"；property 声明服务身上哪个字段是 ctx，包装后该字段
  //    会被重绑定到调用方的上下文；noShadow 表示包装时保留影子链，
  //    服务内部始终能追到自己的真实出处。
  // 2. 把核心服务的常用方法全部 mixin 到 ctx 上——ctx.get、ctx.on、
  //    ctx.plugin 这些"直接写在 ctx 上"的写法就是这么来的。
  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
  }

  /**
   * 从服务仓库里读取一个服务，不要求 inject 声明。
   *
   * @param name — 服务名。
   * @param strict — 为 `true` 时，只接受提供方 fiber 正处于 ACTIVE 状态
   * 的实现。
   * @returns 服务实例；还没人提供（或 strict 模式下未就绪）时返回 `undefined`。
   */
  get(name: string, strict = true) {
    // 找到实现后包一层 traceable 代理再交出去（调用方归因，见 utils.ts）。
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
  }

  // 按"当前上下文的隔离标签"查实现记录。strict 模式下，提供方 fiber 不在
  // ACTIVE 就当作没有——服务要等提供方加载就绪后才算真正可用。
  _getImpl(name: string, strict = true) {
    const key = this.ctx[symbols.isolate][name]
    const impl = key && this.store[key]
    if (!impl) return
    if (strict && impl.fiber.state !== FiberState.ACTIVE) return
    return impl
  }

  /**
   * 覆盖一个已提供服务的值。
   *
   * @param name — 服务名。
   * @param value — 新的服务值。
   * @param error — 装着调用方调用栈的错误对象，用于诊断报错。
   * @returns 成功时返回 `true`。
   * @throws 当 `name` 从未被提供、或由别的 fiber 提供时抛错。
   */
  set(name: string, value: any, error?: Error) {
    const key = this.ctx[symbols.isolate][name]
    const impl = this.store[key]
    // 两道权限闸：
    // 1. 这个名字从没被提供过 → 不能写；
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`)
    }
    // 2. 只有提供它的那个 fiber 本人能改 → 防止插件互相篡改别人的服务。
    if (impl.fiber !== this.ctx.fiber) {
      throw new Error(`cannot set property "${name}" in multiple fibers`)
    }
    impl.value = value
    return true
  }

  /**
   * 把当前 fiber 拥有的一个服务实现注册进容器。
   *
   * 完整契约见上面 `ctx.provide()` 重载的文档。
   *
   * @param name — 服务名。
   * @param value — 服务值。
   * @param check — 可选的可用性检查，依赖方加载前会先调用它。
   * @returns 清理函数，调用它即注销该服务。
   */
  provide(name: string, value?: any, check?: () => boolean) {
    // 整个注册过程托管给 ctx.fiber.effect：这里返回的清理函数会被框架收走，
    // 在 fiber 卸载时逆序自动执行——这是 cordis 一切注册的托管原语，
    // 插件作者不用自己记着"什么时候注销服务"。
    return this.ctx.fiber.effect(() => {
      // 登记属性定义：第一次 provide 时建一条 service 类型的定义；
      // 同名若已被声明成 accessor 等别的类型，属冲突，抛错。
      if (!this.props[name]) {
        this.props[name] ??= { type: 'service' }
      } else if (this.props[name].type !== 'service') {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'service' }

      // 隔离标签：根上下文的 isolate 表里还没有，就为这个名字生成一个 symbol。
      // 之后同一作用域内对 name 的所有读写，都经由这个 symbol 找到同一份实现。
      this.ctx.root[symbols.isolate][name] ??= Symbol(name)
      const key = this.ctx[symbols.isolate][name]
      const impl: Impl = { name, value, fiber: this.ctx.fiber, check }
      // 同一作用域内重复 provide 同名服务 → 抛错，并指出已有注册者是谁。
      if (this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
      }
      // 写两份账：全局实现表按标签存（供所有人按作用域查），当前 fiber 自己
      // 的 store 按名字存（供 fiber 卸载时知道自己提供过什么、供依赖方读取）。
      this.store[key] = impl
      this.ctx.fiber.store![name] = impl
      // 提供方已是 ACTIVE（插件运行起来之后才 provide）→ 立刻广播服务变动，
      // 唤醒等这个服务的依赖方；否则等 fiber 进入 ACTIVE 时由状态迁移统一通知。
      if (this.ctx.fiber.state === FiberState.ACTIVE) {
        this.notify([name])
      }
      // 清理函数（effect 的返回值）：注销服务。除了删表，还要 notify 广播——
      // 依赖方会因失去依赖而开始卸载——并等它们全部卸载完才收尾。
      return async () => {
        delete this.store[key]
        const fibers = this.notify([name])
        await Promise.allSettled(fibers.map(fiber => fiber.await()))
        // 最后才删自己 store 里的记录：依赖方的清理过程中可能还要读这个
        // 服务，先删会让它们在卸载途中读到 undefined。
        delete this.ctx.fiber.store![name]
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  /**
   * 重新评估所有依赖了这些名字的 fiber。
   *
   * @param names — 发生变动的服务名。
   * @param filter — 限定只通知与当前上下文处于同一隔离作用域的 fiber。
   * @returns 依赖状态被刷新过的 fiber 列表。
   */
  notify(names: string[], filter = (ctx: Context, name: string) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
    // notify 是"服务变动广播"，provide/set 之后的级联起停全靠它。
    // 第一步：遍历所有插件 runtime 下的所有 fiber，凡 inject 里依赖了这些
    // 名字、且与当前上下文处于同一隔离作用域（filter）的：先 _checkImpl
    // 重新核对依赖（更新它的依赖快照），再 _refresh 重新评估整体状态——
    // 依赖没了就触发卸载，依赖回来了就触发加载。
    const fibers: Fiber[] = []
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false
        for (const name of names) {
          if (!(name in fiber.inject)) continue
          if (!filter(fiber.ctx, name)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
        fibers.push(fiber)
      }
    }
    // 第二步：向事件总线发 internal/service 事件，让外部监听者感知服务变动。
    // 事件挂在一个临时子 ctx 上发，子 ctx 带 filter，保证事件只送达与
    // 变动服务同一作用域的监听者。
    for (const name of names) {
      const self: Context = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => filter(target, name)
      this.ctx.events.emit(self, 'internal/service', name, this._getImpl(name, false)?.value)
    }
    return fibers
  }

  /**
   * 定义一个由 get/set 钩子支撑的计算属性。
   *
   * @param name — 上下文属性名。
   * @param options — `get` 钩子和可选的 `set` 钩子。
   * @returns 清理函数，调用它即移除该 accessor。
   */
  accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
    // 与 provide 同一个套路：登记进 props 表，把"删除"作为清理函数交给
    // effect 托管，fiber 卸载时自动移除。
    return this.ctx.fiber.effect(() => {
      if (name in this.props) {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'accessor', ...options }
      return () => delete this.props[name]
    }, `ctx.accessor(${JSON.stringify(name)})`)
  }

  /**
   * 把某个服务的部分成员平铺到 `ctx` 上。
   *
   * 完整契约见上面 `ctx.mixin()` 重载的文档。
   *
   * @param source — 上下文属性名，或直接给一个源对象。
   * @param mixins — 要转发的键列表，或"源键 → ctx 键"的映射。
   * @returns 清理函数，调用它即移除所有这次创建的 accessor。
   */
  mixin(source: any, mixins: string[] | Dict<string>) {
    const self = this
    // mixin 的 effect 体是个生成器：每 yield 一个清理函数，框架就立刻注册
    // 一个（见 fiber.ts 的 _execute）——这里每循环一次就建一个转发 accessor，
    // 并把它的注销函数 yield 出去。
    return this.ctx.fiber.effect(function* () {
      // 两种写法统一成 [源键, ctx 键] 对：数组形式同名转发，对象形式可改名。
      const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
      const getTarget = (ctx: Context, error: Error) => {
        // TODO 报错信息可以更友好
        return ctx[source]
      }
      // 为每一对键建一个转发 accessor：
      for (const [key, value] of entries) {
        yield self.accessor(value, {
          // 读：先解析出源服务（source 是属性名时相当于读 ctx[source]）；服务还
          // 没就位（null/undefined）就原样返回。receiver 存在，说明这次访问经由
          // 某个转发入口（比如插件实例的包装对象），用 withProps 把它叠到服务上，
          // 让方法里再访问别的属性时仍沿着调用方的上下文走（归因不断链）。
          // 读到方法时 bind 一下，保证 this 指向服务（或叠加后的转发对象）。
          get(receiver, error) {
            const service = getTarget(this, error)
            if (isNullable(service)) return service
            const mixin = receiver ? withProps(receiver, service) : service
            const value = Reflect.get(service, key, mixin)
            if (typeof value !== 'function') return value
            return value.bind(mixin ?? service)
          },
          // 写：同样先解析源服务、叠加转发入口，然后转发这次写入。
          set(value, receiver, error) {
            const service = getTarget(this, error)
            const mixin = receiver ? withProps(receiver, service) : service
            return Reflect.set(service, key, value, mixin)
          },
        })
      }
    }, `ctx.mixin(${JSON.stringify(source)})`)
  }

  /**
   * 给值挂上本上下文的追踪包装（traceable 代理）。
   *
   * @param value — 要包装的值。
   * @returns 追踪包装；值不适用包装（不是对象、没有 tracker 标记）时原样返回。
   */
  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  /**
   * 包装一个回调，使它被调用时，this 和实参都会先换上本上下文的追踪包装。
   *
   * 用途：插件把这个回调交给别的服务后，回调里再通过 ctx 做的任何注册，
   * 都能被归因到本插件头上，插件卸载时才能清干净。
   *
   * @param callback — 要包装的函数。
   * @returns 代理：委托给 `callback`，但 this 与实参先经过追踪包装。
   */
  bind<T extends Function>(callback: T) {
    // apply 拦截"当函数调"，construct 拦截"当构造函数 new"：两种用法下都把
    // this 和实参换成带本上下文归因的追踪版本，再委托给原函数。
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map(arg => this.trace(arg)), newTarget)
      },
    })
  }
}
