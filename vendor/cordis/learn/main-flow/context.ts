// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../../src/context.ts
import type { Dict } from '@deepseek-ai/cosmokit'
import { EventsService } from './events.ts'
import { LoggerService } from './logger.ts'
import { ReflectService } from './reflect.ts'
import { RegistryService, type InjectKey } from './registry.ts'
import { getTraceable, symbols } from './utils.ts'
import { Fiber } from './fiber.ts'

/**
 * Cordis 上下文对外的"类型长相"。
 *
 * 运行时的 Context 类被 Proxy 包裹，属性读取走的是服务解析而不是普通字段，
 * 所以 `ctx.xxx` 能拿到什么没法在类定义里写死。框架核心服务和各个插件会用
 * "声明合并"（在各自模块里再次声明同名 interface）往这个接口上补字段；
 * 这里只列出最核心的成员，完整清单分散在各模块的 `declare module` 块里。
 */
export interface Context {
  /** 隔离表：服务名 → 作用域标签。查找该服务时，会到其标签对应的作用域里解析。 */
  [symbols.isolate]: Dict<symbol>
  /** 拦截表：服务名 → 要合并进该服务"每插件配置"里的配置片段。 */
  [symbols.intercept]: Dict
  /** 应用的根上下文（所有子上下文共享同一个根）。@experimental */
  root: this
  /** 解析相对的插件/模块路径时使用的基准 URL，由运行时按需设置。 */
  baseUrl?: string
  /** 事件总线。它的方法同时被"混入"到 ctx 上，所以能直接写 `ctx.on`、`ctx.emit` 等。 */
  events: EventsService
  /** 日志服务。调用 `ctx.logger(name)` 可以得到一个带名字的日志器。 */
  logger: LoggerService
  /** 反射层：context 代理背后真正干活的"服务解析器"（`ctx.get`、`ctx.provide` 等由它实现）。 */
  reflect: ReflectService
  /** 插件注册表。它的方法同样被混入 ctx（`ctx.plugin`、`ctx.inject`）。 */
  registry: RegistryService
}

/**
 * Cordis 插件的依赖容器：应用有一个根 Context，插件可逐级派生子 Context。
 *
 * Context 本质上是一个 Proxy（代理对象）：读 `ctx.foo` 不是取普通字段，
 * 而是走服务解析流程（去服务表里找 `foo` 的实现）；`extend()`、`isolate()`、
 * `intercept()` 三个方法用来在不修改父上下文的前提下，派生出携带额外
 * 作用域规则的子上下文。
 */
export class Context {
  /** symbol 键：effect 的清理函数（disposer）用它挂载自己的诊断信息树（EffectMeta）。 */
  static readonly effect: unique symbol = symbols.effect
  /** symbol 键：存放上下文的事件过滤器；每次派发事件时都会参考它筛选监听器。 */
  static readonly filter: unique symbol = symbols.filter
  /** symbol 键：隔离表（含义见上面的 `Context[symbols.isolate]` 属性）。 */
  static readonly isolate: unique symbol = symbols.isolate
  /** symbol 键：拦截表（含义见上面的 `Context[symbols.intercept]` 属性）。 */
  static readonly intercept: unique symbol = symbols.intercept

  /** 构造根上下文，并安装框架自带的核心服务。 */
  constructor() {
    // 两张空字典（无原型，避免和 Object.prototype 上的键撞名）：
    // 隔离表与拦截表，分别服务于 isolate() 和 intercept()。
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    // 关键一步：用 ReflectService.handler 把 this 包成代理。之后所有属性
    // 读写都先经过 handler（服务解析、internal/get、internal/set 等拦截
    // 都在那里发生），外界拿到的自始至终是这个代理 self 而不是裸 this。
    const self = new Proxy<this>(this, ReflectService.handler)
    this.root = self
    this.baseUrl = undefined
    // 根上下文自己也挂一个"根 fiber"：它不属于任何插件、没有父 fiber，
    // 伴随应用终身存在，是框架内建注册（如下面的内置监听器）的挂靠点。
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    // 依次安装四个核心服务；注意传的都是代理 self，服务之间互相引用时
    // 同样走代理的服务解析。
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
    // 安装服务的过程中，根 fiber 上会被注册一些 effect（比如事件监听器）。
    // 根 fiber 永不卸载，这些清理函数没有执行的机会，直接清空以免白白堆积。
    this.fiber._disposables.clear()
    // JS 里构造函数显式返回一个对象会取代默认的 this，所以
    // `new Context()` 实际得到的是代理 self。
    return self
  }

  /**
   * 在当前作用域之上派生一个带额外"元数据"属性的子上下文。
   *
   * 原理是原型继承：子上下文以当前上下文为原型，父级的所有属性都能读到；
   * `meta` 里的自有属性会遮住继承来的同名属性。父上下文本身完全不被修改。
   *
   * @param meta — 要直接定义在子上下文上的自有属性（symbol 键也可以）。
   * @returns 继承自当前上下文的子上下文。
   */
  extend(meta = {}): this {
    // shadow 是 traceable 代理（utils.ts 的 getTraceable）做"调用方归因"
    // 用的标记：插件通过某个服务方法拿到的是一个影子上下文，上面记着
    // 这个调用链的原始来源。extend 时要把标记继续传下去，否则归因链
    // 一断，"这次注册算在哪个插件头上"就查不到了。
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    // 以"当前上下文的 traceable 版本"为原型建子对象：读属性沿原型链
    // 落到父级，写属性只影响子级——这就是"不改父上下文"的实现方式。
    const self = Object.create(getTraceable(this, this))
    // 把 meta 的自有属性（含 symbol 键，连 getter/setter 等描述符一起）
    // 原样定义到子上下文上，遮住原型链上的同名属性。
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }
    if (!shadow) return self
    // 当前上下文带着 shadow 标记时，在子上下文外面再包一层、把标记
    // 原样贴回去，让归因信息在派生链上存续。
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
  }

  /**
   * 为服务 `name` 开辟一个独立作用域，返回对应的子上下文。
   *
   * 好比给这个服务单独换了一个抽屉：在返回的子上下文（及它再派生的后代）
   * 里，读写 `name` 服务都会落到新标签对应的存储里，可以在其中提供另一套
   * 实现而不影响父作用域。给两次 `isolate()` 传同一个 `label`，两边就会
   * 共用同一个作用域（抽屉合并）。
   *
   * @param name — 要隔离的服务名。
   * @param label — 要加入的作用域标签；不传则自动生成一个全新的唯一 symbol。
   * @returns 一个子上下文，其 `name` 服务在新作用域里解析。
   */
  isolate(name: string, label?: symbol) {
    // 以父级隔离表为原型建一张新表（链式查找：改子表不动父表），
    // 把 name 映射到新标签，再 extend 出携带这张表的子上下文。
    const shadow = Object.create(this[symbols.isolate])
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  /**
   * 为"在本上下文之下启动的插件"追加针对某个服务的拦截配置。
   *
   * 之后在返回的子上下文里加载插件时，插件看到的该服务配置 = 祖先各层的
   * 拦截片段先合并、再并入本层 `config` 的结果（合并逻辑见
   * `Service[symbols.resolveConfig]`）。父上下文不受影响。
   *
   * @param name — 要拦截配置的服务名。
   * @param config — 要合并给该服务的拦截配置。
   * @returns 携带这条新拦截项的子上下文。
   */
  intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
  intercept(name: string, config: any): this
  intercept(name: string, config: any) {
    // 与 isolate 同一套路：原型链式地复制拦截表，写入本层配置，
    // 再 extend 出去。服务解析配置时会沿这条链把各层片段依次合并。
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}
