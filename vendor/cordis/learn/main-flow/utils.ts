// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../utils.ts
import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Context, Service } from './index.ts'

/**
 * 有序的“可清理对象”集合：按值删除只需 O(1)。
 * 用一张 Map 按序号存值（保持插入顺序），再加一张 WeakMap 按值反查序号；
 * WeakMap 不阻止垃圾回收，值被回收后对应映射自动消失。
 * fiber 卸载时靠它按“后注册先清理”的逆序逐一处置登记过的清理项。
 */
export class DisposableList<T extends WeakKey> {
  private sn = 0
  private map = new Map<number, T>()
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  // 入队并返回一个注销函数：调用它只删这一项，不影响其他
  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  delete(value: T) {
    const sn = this.weak.get(value)
    if (!sn) return false
    return this.map.delete(sn)
  }

  // 清空并返回全部值（逆序）：配合 fiber 卸载时“后注册先清理”的顺序
  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }
}

/**
 * traceable 代理的追踪元数据：告诉代理怎样把服务实例和调用方的上下文重新绑定。
 * associate —— 关联服务名，读 `associate.属性` 时转发到上下文上的同名属性；
 * property —— 实例上存上下文的属性名（一般是 ctx），读它时换成调用方的上下文；
 * noShadow —— 为 true 时不剥影子上下文，让服务能感知自己最初的归属
 * （例如 logger 要用来源 fiber 的名字当默认日志名）。
 */
export interface Tracker {
  associate?: string
  property?: string
  noShadow?: boolean
}

/**
 * 内部共用的 Symbol 表。
 * 框架要在用户对象上挂各种隐藏字段，用 Symbol.for 注册的 Symbol 当键，
 * 既不会和用户代码的属性名冲突，又能跨模块、跨 realm 拿到同一个键。
 */
export const symbols = {
  // 内部通用符号
  shadow: Symbol.for('cordis.shadow'),
  receiver: Symbol.for('cordis.receiver'),
  original: Symbol.for('cordis.original'),
  metadata: Symbol.for('cordis.metadata'),
  initHooks: Symbol.for('cordis.initHooks'),
  checkProto: Symbol.for('cordis.checkProto'),

  // 上下文相关符号
  effect: Symbol.for('cordis.effect') as typeof Context.effect,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // 服务相关符号
  init: Symbol.for('cordis.init') as typeof Service.init,
  check: Symbol.for('cordis.check') as typeof Service.check,
  config: Symbol.for('cordis.config') as typeof Service.config,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  resolveConfig: Symbol.for('cordis.resolveConfig') as typeof Service.resolveConfig,
}

// 这两个内置构造器不在全局暴露，只能从实例的 constructor 上间接拿到
const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

/** 判断一个插件回调是否应该用 new 调用（即它是不是“可当类用”的函数）。 */
export function isConstructor(func: any): func is new (...args: any) => any {
  // 箭头函数和 async 函数都没有 prototype，天然不能 new
  if (!func.prototype) return false
  // 生成器函数也不能 new
  if (func instanceof GeneratorFunction) return false
  if (func instanceof AsyncGeneratorFunction) return false
  return true
}

/**
 * 缝合两条原型链：返回一条新链，proto1 的每一层都插在 proto2 之上，
 * 且每层的属性（含 getter/setter 等描述符）以 proto1 为准。
 * 用途：createCallable 用它把“服务类的原型”和 Function.prototype 缝在一起，
 * 让可调用服务既能被当函数调、又能用服务类上的方法。
 */
export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  // 递归到底：先缝好上一层的链作为本层结果的原型，
  // 再把 proto1 本层的自有属性原样（连同描述符）拷过来
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

/** 判断是否为非 null 的对象或函数——只有这两类能挂属性、值得被代理。 */
export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

/** 沿原型链向上找某个属性的描述符（能区分数据属性和 getter/setter），找不到返回 undefined。 */
export function getPropertyDescriptor(target: any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

/**
 * 给服务/函数包一层追踪代理：让别人通过它调用方法时，
 * 方法内部看到的上下文是“调用方的活动上下文”，而不是服务自己出生时的上下文。
 * 这就是“调用方归因”：插件通过服务做的注册，要算在插件头上。
 */
export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  // 自带 shadow 标记的说明它已经是包装产物，真身在原型上，直接返回真身
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  // 没有追踪元数据的普通对象不需要包装
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

/** 返回一个代理：读写时优先取 props 里的覆盖值，其余照旧落到 target 上。 */
export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      // constructor 不允许覆盖：否则 instanceof、类名推断等检查都会被带偏
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

// withProps 的单属性版本，且该属性是只读的
function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

// 为一次方法调用准备“影子 this”：把调用方上下文包一层 extend 子上下文，
// 子上下文里用 symbols.shadow 记下服务的原始上下文，再覆盖到 receiver 的同名属性上。
// 这样方法内部读 this.ctx 拿到的是调用方的上下文，但顺着 shadow 还能找回服务的“娘家”
function createShadow(ctx: Context, target: any, property: string | undefined, receiver: any) {
  if (!property) return receiver
  const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value
  if (!origin) return receiver
  return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }))
}

// 包装一个普通方法：当它经由外层代理被调用（this 是 outer）时，
// 把 this 换成影子 this；返回值也递归过一遍 getTraceable，能包的继续包
function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  // noShadow 的服务是“认娘家”的（比如 logger 要用最初所属 fiber 的名字来命名）：
  // 保留影子 ctx，让它能读 [symbols.shadow] 找回来源。
  // 普通服务则把影子剥掉（取原型的上一层），它的副作用算在调用方头上，而不是来源头上。
  if (ctx[symbols.shadow] && !tracker.noShadow) {
    ctx = Object.getPrototypeOf(ctx)
  }
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      // 读 symbols.original：交出被包裹的真身（拆包用）
      if (prop === symbols.original) return target
      // 读上下文属性（一般是 ctx）：返回调用方的上下文——“归因”的关键一步
      if (prop === tracker.property) return ctx
      // 其余 Symbol 属性不做转发，原样读
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      // 读 `associate.属性` 且上下文上确实有这个属性时，转发到上下文上读；
      // 同时给 ctx 盖一个 receiver 标记，让更深层知道真正的接收者是谁
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      let shadow: any, innerValue: any
      const desc = getPropertyDescriptor(target, prop)
      if (desc && 'value' in desc) {
        // 数据属性：直接取值
        innerValue = desc.value
      } else {
        // 访问器属性（getter）：以影子 this 执行，让 getter 里的 this.ctx 指向调用方
        shadow = createShadow(ctx, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        // 取到的值自己也带追踪元数据：递归包一层
        return createTraceable(ctx, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        // 普通方法：包成 shadow 方法，调用时换 this、包返回值
        shadow ??= createShadow(ctx, target, tracker.property, receiver)
        return createShadowMethod(ctx, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      // symbols.original 和上下文属性是只读的：静默拒绝（返回 false 表示写入失败）
      if (prop === symbols.original) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      // 写 `associate.属性` 时同样转发到上下文上
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      // 其余写入落在影子 this 上，不直接改动服务对象本身
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    // 通过代理直接调用这个服务函数时，走统一分发
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args)
    },
  })
  return proxy
}

// 统一分发：没有 [symbols.invoke] 的按普通函数调用；
// 有 invoke 调用体的改由它接管，this 绑成代理（让调用体内读 this.ctx 也拿到调用方上下文）
function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

/** 造一个“可调用的服务对象”：本身是函数，每次被调用都先造追踪代理，再分发到 [symbols.invoke] 调用体。 */
export function createCallable(name: string, proto: {}, tracker: Tracker) {
  // self 就是那个函数：被调用时按 self.ctx（调用时可能已被代理换成调用方的）
  // 造追踪代理，再走统一分发
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return applyTraceable(proxy, self, this, args)
  }
  // 函数名改成服务名（调试输出里更好看），原型缝成传进来的链
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

// 一次 composeError 调用的簿记：在调用点抓的快照 Error（用来对齐堆栈帧）和帧偏移量
interface StackInfo {
  offset: number
  error: Error
}

// 把抛出的错误的堆栈“缝”上外层（同步调用方）的堆栈帧，然后继续抛。
// 背景：异步代码抛错时，错误的 stack 往往只剩异步那一段，看不到当初是谁发起的调用；
// 这里在错误堆栈里找到内、外两段的重叠帧，把外层帧插进去，让堆栈从头到尾完整。
function handleError(info: StackInfo, reason: any, getOuterStack: () => string[]): never {
  const innerLines = info.error.stack!.split('\n')

  // 长堆栈拼接：快照 Error 的第 3 行是它记录的第一个真实调用帧，
  // 在 reason 的堆栈里找到这一行，就找到了内、外两段的接缝
  const lines: string[] = reason.stack.split('\n')
  let index = lines.indexOf(innerLines[2])
  // 找不到重叠帧说明两段堆栈没有关联，没法拼，原样抛
  if (index === -1) throw reason

  index -= info.offset
  // 接缝上方若还压着匿名帧（`(<anonymous>)`），一并吞掉，让拼接位置更自然
  while (index > 0) {
    if (!lines[index - 1].endsWith(' (<anonymous>)')) break
    index -= 1
  }
  // 接缝处往后的内层帧全部替换为外层帧，就地改好错误对象的 stack 后继续抛
  lines.splice(index, Infinity, ...getOuterStack())
  reason.stack = lines.join('\n')
  throw reason
}

/**
 * 执行回调；如果它（同步或异步地）抛错，先把外层调用点的堆栈帧拼进错误的
 * 堆栈再抛出。调用方多包一层 composeError，用户看到的错误堆栈就能穿越
 * 异步边界，一直追到最初的发起处。
 */
export function composeError<T>(callback: (info: StackInfo) => T, getOuterStack = buildOuterStack()): T {
  // 此刻新建 Error 不为抛错，只为抓一份当前位置的堆栈快照
  const info: StackInfo = { offset: 1, error: new Error() }

  try {
    const result: any = callback(info)
    if (isObject(result) && 'then' in result) {
      // 回调返回 Promise：只拦截失败分支（then 的第二个参数），成功值原样透传
      return (result as any).then(undefined, (reason) => handleError(info, reason, getOuterStack)) as T
    } else {
      return result
    }
  } catch (reason: any) {
    handleError(info, reason, getOuterStack)
  }
}

/**
 * 现在就抓一份调用栈，但返回一个惰性函数：之后真要拼堆栈时才切片取用。
 * 这样没出错时只有抓栈的固定开销，不出错的正常路径几乎零成本。
 */
export function buildOuterStack(offset = 0) {
  const outerError = new Error()
  // slice(3 + offset) 去掉 Error 标题行、buildOuterStack 自身等无关帧
  return () => outerError.stack!.split('\n').slice(3 + offset)
}
