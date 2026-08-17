// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../../src/service.ts
import { defineProperty } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { createCallable, joinPrototype, symbols, type Tracker } from './utils.ts'

/**
 * 服务的基类：服务就是“在 ctx 上以固定名字暴露一组 API 的对象”。
 *
 * 子类在自己的构造函数里调用 `super(ctx, name)`，实例会立即注册进上下文。
 * 注册由所属 fiber（插件的运行时实例）托管：fiber 卸载时服务自动注销，
 * 子类不需要自己写任何清理代码。
 */
export abstract class Service<out T = never> {
  /** 实例方法的 Symbol 键：类插件（用 class 写法实现的插件）在构造完成后，框架会调用这个方法做后续初始化。 */
  static readonly init: unique symbol = symbols.init
  /** 传给 `ctx.provide()` 的可用性判断方法的 Symbol 键：返回 false 表示服务尚未就绪。 */
  static readonly check: unique symbol = symbols.check
  /** “幽灵”类型参数的 Symbol 键：只在类型层面携带 intercept 配置的类型 T，运行时不存任何值。 */
  static readonly config: unique symbol = symbols.config
  /** 调用体方法的 Symbol 键：定义了它的服务实例本身可以像函数一样被调用（例如 `ctx.logger()`）。 */
  static readonly invoke: unique symbol = symbols.invoke
  /** 派生扩展实例的辅助方法的 Symbol 键：在原服务基础上叠加少量属性得到新实例。 */
  static readonly extend: unique symbol = symbols.extend
  /** 追踪元数据的 Symbol 键：traceable 代理靠它识别“谁在使用这个服务”，把副作用记到真正的调用方头上。 */
  static readonly tracker: unique symbol = symbols.tracker
  /** 下方“合并 intercept 配置”辅助方法的 Symbol 键。 */
  static readonly resolveConfig: unique symbol = symbols.resolveConfig

  declare [symbols.config]: T

  /** 本实例注册进上下文时使用的服务名。 */
  public name!: string

  /**
   * 把本实例以 `name` 注册进当前上下文。
   *
   * 内部调用 `ctx.reflect.provide(name, this, this[Service.check])`，
   * 注册动作记在当前 fiber 名下，fiber 卸载时服务随之自动注销。
   * 定义了 `[Service.invoke]` 调用体的服务，返回的是一个“可调用的实例”
   * （既能 `ctx.xxx()` 当函数调，又能访问 `ctx.xxx.yyy` 上的方法属性）。
   *
   * @param ctx — 要注册进的上下文（存为 `this.ctx`）。
   * @param name — 服务名；缺省时取类上的静态 `provide` 字段。
   */
  constructor(protected ctx: Context, name: string) {
    // 没传名字就退回类上的静态 provide 字段（服务类通常用 static provide 声明默认服务名）
    name ??= this.constructor['provide'] as string

    let self = this
    // 追踪元数据，交给 traceable 代理做“调用方归因”：
    // property: 'ctx' —— 别人通过代理读实例的 ctx 属性时，换成调用方自己的上下文；
    // associate: name —— 形如 `服务名.属性` 的上下文属性也视为属于本服务。
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    // 服务定义了调用体时，把实例包装成可调用的对象：
    // 造一个函数，把本类原型和 Function.prototype 缝成一条原型链接给它，
    // 于是这个函数既能直接调用，又能访问服务类上的方法
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
    }
    self.ctx = ctx
    self.name = name
    // 把追踪元数据挂到实例上，之后被别的插件经代理访问时才能被识别
    defineProperty(self, symbols.tracker, tracker)

    // 正式注册：reflect 层会把这次登记记到当前 fiber 头上，卸载时自动撤销
    self.ctx.reflect.provide(name, self, this[symbols.check])
    // 构造函数显式返回一个对象时，new 表达式的结果就是这个对象而非默认的 this；
    // 可调用服务靠这一句把包装后的函数交出去
    return self
  }

  /**
   * 可见性过滤器：事件派发、服务变更通知时都会被参考，判断本服务对某个上下文是否“可见”。
   * 隔离（isolate）机制会给子上下文一份独立的服务视图；这里比较派发方与本服务
   * 所属上下文的隔离表里、本服务名下的条目是不是同一个——不同就说明跨了隔离
   * 边界，本服务不应收到这个事件。
   */
  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
  }

  /**
   * 派生一个扩展实例：可调用服务先再造一个可调用对象，普通服务直接用
   * `Object.create(this)` 以本实例为原型创建子对象，最后把 props 覆盖上去。
   * 用途：想在原服务上加点东西，又不想污染原实例。
   */
  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  /**
   * 沿上下文链合并本服务的 intercept 配置，再叠加可选的 base 与 head。
   *
   * 每个上下文都能用 intercept 给服务追加一份配置；越靠近根的越先生效，
   * 越靠近当前上下文的优先级越高。`base` 排在所有拦截配置之前（优先级最低），
   * `head` 排在最后（优先级最高）。服务类上挂了带 `merge` 方法的 `Config`
   * （通常是 schemastery 的 Schema 对象）时按它的规则合并，否则退化为
   * 浅层的 `Object.assign`（后者整体覆盖前者的同名字段）。
   *
   * @param base — 最先合并、优先级最低的基础配置。
   * @param head — 最后合并、优先级最高的覆盖配置。
   * @returns 合并后的完整配置。
   */
  [symbols.resolveConfig](base?: T, head?: T): T {
    let intercept = this.ctx[Context.intercept]
    const configs: any[] = []
    // 从当前上下文的 intercept 表沿原型链一路向父上下文走：
    // 某层“自己直接声明了”本服务的配置才收集（in 判断包含原型链，hasOwn 再确认归属）；
    // unshift 让越靠根的配置排越前，合并时子上下文的配置自然覆盖父上下文
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        configs.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    if (base) configs.unshift(base)
    if (head) configs.push(head)
    if (this['Config']?.merge) {
      return this['Config'].merge(...configs)
    } else {
      return Object.assign({}, ...configs)
    }
  }
}
