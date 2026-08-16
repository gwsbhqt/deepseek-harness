import { defineProperty, isNullable } from '@deepseek-ai/cosmokit'
import type { Awaitable, Dict } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import type { Plugin } from './registry.ts'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils.ts'
import type { Impl } from './reflect.ts'
import type { StandardSchemaV1 } from '@standard-schema/spec'

declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect'> {
    /** 拥有这个上下文的 fiber（插件运行时实例）。 */
    fiber: Fiber
  }
}

// 用全局 Symbol 给 ValidationError 打标记，跨包也能认出这类错误（用于错误分类判断）。
const kValidationError = Symbol.for('ValidationError')

/** 插件配置未通过 standard-schema 校验时抛出的错误。 */
export class ValidationError extends TypeError {
  name = 'ValidationError'

  /**
   * 把 schema 报告的所有问题拼成一条多行错误信息。
   *
   * @param issues — standard-schema 报告的问题列表，每个问题占一行。
   */
  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path) {
        return `  - ${issue.message} (at ${issue.path.join('.')})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }
}

// 在原型上打标，所有 ValidationError 实例都带这个标记。
Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

/**
 * 在插件运行时启动前，校验并规范化它的配置。
 *
 * @param runtime — 要套用 `Config` 校验规则的插件运行时。
 * @param config — 用户传入的原始配置。
 * @returns 校验通过后的配置；运行时没有声明校验规则时原样返回 `config`。
 * @throws {ValidationError} 校验发现问题时抛出。
 */
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  // TODO: 支持异步校验
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}

// 既可调用、又可 await 的清理函数：调它开始清理，await 它拿到"清理函数本身"。
interface AsyncDisposable<T extends Awaitable<void> = Awaitable<void>> extends PromiseLike<() => T> {
  (): T
}

/**
 * effect 返回的清理函数，用来在销毁阶段释放资源。
 *
 * 所属 fiber 卸载时，清理函数按注册的逆序执行；清理函数可以是异步的，
 * 此时卸载流程会等待它完成。
 */
export type Disposable<T = any> = () => T

/**
 * `ctx.effect()` 和插件启动回调所接受的返回值形态。
 *
 * 可以是单个清理函数、一个 resolve 出清理函数的 Promise，或者一个
 * （可异步的）迭代器逐个产出多个清理函数——生成器形态的 effect 每产出
 * 一个清理函数就立即登记一个。
 */
export type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>

type SyncEffect<T = any> =
  | Disposable<T>
  | Iterable<Disposable<T>, void, void>

type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>

/** 诊断用的树节点：把有嵌套关系的 effect 标签组织成一棵树。 */
export interface EffectMeta {
  /** 给人看的 effect 标签，例如 `ctx.on("event")` 或 `ctx.provide("name")`。 */
  label: string
  /** 本 effect 运行期间嵌套注册的子 effect 的元数据。 */
  children: EffectMeta[]
}

// 把"执行一次 effect 并收集清理函数"所需的东西打包在一起：
// epoch 是本次执行的世代标记（世代变了说明这次执行已过期）；
// execute 是真正跑插件代码的函数；collect 登记产出的清理函数；
// getOuterStack 在出错时拼接调用方栈，方便定位是谁注册的。
interface EffectRunner<T> {
  epoch: T
  execute: () => any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

// 对外返回的清理函数仍然是"一次性"的（重复调用是空操作），但框架内部的
// 结构性拥有者（比如 fiber 的卸载流程）和外层 effect 需要能"搭车"：当
// 别人已经发起了一次清理时，它们要等待那次清理结束，而不是再跑一遍。
// 这张表记录每个清理函数当前正在进行的清理任务，供搭车者 await。
const effectInertia = new WeakMap<Disposable, () => void | Promise<void>>()

// 执行一个清理函数；如果别处已经发起了对它的清理（effectInertia 里有
// 记录），就改为等待那次清理的结果，避免同一批资源被清理两遍。
function runDisposable(dispose: Disposable) {
  const result = dispose()
  return effectInertia.get(dispose)?.() ?? result
}

/** 广播插件销毁通知；逐个隔离观察者的异常，不让一个监听器搞砸整个所有权清理。 */
function emitPluginDisposed(context: Context, fiber: Fiber) {
  const args: any[] = ['internal/plugin', fiber]
  let callbacks: Function[]
  try {
    callbacks = context.events.dispatch('emit', args)
  } catch (error) {
    context.logger.error(error)
    return
  }
  for (const callback of callbacks) {
    try {
      const returned = callback(...args)
      void Promise.resolve(returned).catch(error => context.logger.error(error))
    } catch (error) {
      context.logger.error(error)
    }
  }
}

/**
 * 单个插件 fiber 的生命周期状态。
 *
 * `PENDING` —— 在等齐依赖的服务；`LOADING` —— 插件回调正在执行；
 * `ACTIVE` —— 加载完成、正在提供服务；`FAILED` —— 回调或配置抛了异常；
 * `UNLOADING` —— 清理函数正在执行；`DISPOSED` —— fiber 已被移除，不能再启动。
 */
export const enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

/** 带稳定机器可读错误码的框架错误。 */
export class CordisError extends Error {
  /**
   * @param code — 稳定的错误码；未提供 message 时也作为默认错误信息。
   * @param message — 可选的、给人看的错误信息，覆盖默认信息。
   */
  constructor(public code: CordisError.Code, message?: string) {
    super(message ?? CordisError.Code[code])
  }
}

/** Cordis 错误码的定义。 */
export namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

// epoch 的特殊取值：表示"当前不可激活"（依赖没齐或已出错）。
// 用字符串而不是 false，是为了和正常的 epoch 指纹串共用一种类型。
const INACTIVE = '__INACTIVE__'

/**
 * 一次插件应用的运行时实例。
 *
 * fiber 负责跟踪依赖状态、校验过的配置、生命周期 effect 和清理工作，
 * 对应 `ctx.plugin()` 返回的那个插件上下文。
 */
export class Fiber {
  /** 在注册表里的唯一 id；根 fiber 为 0，销毁后置为 `null`。 */
  public uid: number | null
  /** 本 fiber 的插件所运行的上下文（继承自父上下文）。 */
  public readonly ctx: Context
  /** 校验后的插件配置（由 `update()` 更新）。 */
  public config: any
  /** 未经校验的原始插件配置，每次激活前重新走一遍校验。 */
  public _config: any
  /** 当前生命周期状态；每次迁移都会派发 `internal/status` 事件。 */
  public state = FiberState.PENDING
  /** 销毁本 fiber：卸载插件，等清理全部结束后才算完成。 */
  public readonly dispose: () => Promise<void>
  /** 加载期间所需服务实现的快照；未加载时为 `undefined`。 */
  public store: Dict<Impl> | undefined
  /** 正在进行的加载/卸载迁移（如果当前有的话）。 */
  public inertia: Promise<void> | undefined

  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  public readonly _disposables = new DisposableList<Disposable>()

  // 与 `this.ctx` 是同一个对象，只是这里的类型标注更精确。
  protected context: Context

  private _error: any
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)

  /**
   * 创建一个 fiber。插件作者一般通过 `ctx.plugin()` 获得 fiber，
   * 不会直接调用这个构造函数。
   *
   * @param parent — 加载该插件的上下文。
   * @param config — 原始配置，会按运行时的 schema 校验。
   * @param inject — 解析好的依赖表（服务名 → 拦截配置）。
   * @param runtime — 共享的插件运行时；根 fiber 传 `null`。
   * @param getOuterStack — 捕获调用方栈，用于 effect 诊断信息。
   */
  constructor(
    public parent: Context,
    config: any,
    public inject: Dict<any>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
  ) {
    this._config = config
    // collect 把清理函数登记进本 fiber 的总清理列表，卸载时统一逆序执行。
    const collect = (dispose: Disposable) => {
      this._disposables.push(dispose)
    }

    if (runtime) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ fiber: this })

      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
        for (const [name, config] of injectEntries) {
          if (isNullable(config)) continue
          this.ctx[Context.intercept][name] = config
        }
      }

      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function () {
          // 插件有两种形态：类（用 new 实例化，并跑它的初始化钩子）
          // 和普通函数（直接调用）。两种形态产出的清理内容都走同一套收集。
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }

      // 把"销毁这个子 fiber"注册为父 fiber 的一个 effect：父 fiber 卸载时，
      // 子 fiber 会自动随之销毁——这就是插件树的级联清理。
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        return async () => {
          // 销毁流程：摘掉 uid 标记 → 广播销毁通知 → 从运行时登记表移除 →
          // 把 epoch 打回 INACTIVE → 等所有进行中的加载/卸载迁移收尾。
          this.uid = null
          emitPluginDisposed(this.context, this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          // 处于 PENDING 的 fiber 可能已经拥有由 internal/plugin 观察者
          // 注册的 effect。此时它的 epoch 仍是 INACTIVE，_setEpoch() 没有
          // 状态迁移可驱动；所以在汇报"销毁完成"之前，要显式卸载这批
          // 激活之前就挂上的工作。
          if (!this.inertia) {
            this._updateState(() => {
              this.inertia = this._unload()
              return FiberState.UNLOADING
            })
          }
          // `this.inertia` 本身理论上永远不会 reject——`_reload` 和 `_unload`
          // 都会通过 `ctx.logger.error` 吞掉自己工作里的错误。万一它真的
          // reject 了，唯一可能的原因是 logger 自己也挂了，而这个位置恰好
          // 无法补救（再调一次 logger 正是刚才失败的操作）。所以让拒绝
          // 直接传播出去，进程级崩溃是此时最诚实的结果。
          while (this.inertia) {
            await this.inertia
          }
        }
      }, 'ctx.plugin()')

      try {
        // 只有当父 fiber 完整持有这个子 fiber 的 disposer 之后才对外发布。
        // 因为同步的观察者可能在通知里立刻销毁这个 fiber 或它的父 fiber。
        this.context.emit('internal/plugin', this)
      } catch (error) {
        // 同步发布失败了。disposer 会把这个子 fiber 从父级和运行时两边
        // 都移除干净，然后才把错误继续抛给调用方。
        void Promise.resolve(this.dispose()).catch(reason => this.ctx.logger.error(reason))
        throw error
      }

      // 保持首次通知时历史上的 PENDING 视角。loader 也可能在这次通知里
      // 追加 `inject` 声明，所以依赖解析要放到发布之后。如果发布期间父级
      // 被重入式地卸载了，就改由子 fiber 的 disposer 负责排空 PENDING
      // 期间挂上的 effect。
      if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
        for (const name of Object.keys(this.inject)) {
          this._checkImpl(name)
        }
        this._refresh()
      }
    } else {
      // 根 fiber：不对应任何插件，常驻 ACTIVE，dispose 等价于 restart。
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._runner = {
        epoch: '',
        getOuterStack,
        execute: () => {},
        collect,
      }
      this.dispose = () => this.restart()
    }
  }

  /** 插件的显示名：沿祖先链找最近的有名字的插件，都没有则是 `'root'`。 */
  get name() {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  /**
   * 如果 fiber 已经被销毁就抛错。
   *
   * @returns fiber 还活着时不返回任何内容。
   * @throws {CordisError} fiber 的 uid 已被清空时抛出 `INACTIVE_EFFECT`。
   */
  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  // 统一执行各种形态的 effect：单个清理函数、Promise、同步/异步迭代器。
  // 产出的每个清理函数都经 runner.collect 登记；异步迭代器每次迭代前
  // 检查 epoch，世代一旦过期（比如卸载已开始）就立即停止产出。
  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    return composeError((info) => {
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute.call(this)
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        // 没有返回任何清理内容，无需处理
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        return effect.then(safeCollect)
      } else if (Symbol.iterator in effect) {
        info.error = new Error()
        const iter = effect[Symbol.iterator]()
        while (true) {
          const result = iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = effect[Symbol.asyncIterator]()
        return (async () => {
          // 强制制造一次异步边界，让之后的错误栈带上完整的异步调用链
          await Promise.resolve()
          info.error = new Error()
          while (true) {
            if (runner.epoch !== oldEpoch) return
            const result = await iter.next()
            safeCollect(result.value)
            if (result.done) return
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack)
  }

  /**
   * 在本 fiber 上注册一个"自带清理"的 effect。
   *
   * `execute` 会立即执行；它产出的清理函数会被收集起来，在返回的
   * disposer 被调用时、或 fiber 卸载时按逆序执行，以先到者为准。重复
   * 调用 disposer 是空操作。fiber 已销毁时抛
   * `CordisError('INACTIVE_EFFECT')`；`execute` 返回了不合法的形态时抛
   * `TypeError`。
   *
   * @param execute — effect 本体；接受的形态见 {@link Effect}。
   * @param label — 在 `getEffects()` 诊断信息里展示的 effect 标签。
   * @returns 一个 disposer：拆掉这个 effect，并在清理结束后 settle。
   */
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** 同上，但接受异步 effect；返回的 disposer 本身也可以被 await。 */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    this.assertActive()
    if (this.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }

    // 本 effect 自己收集到的清理函数（与 fiber 的 _disposables 是两份登记，
    // 见下面 runner.collect 里的 delete：被这里接管的就不再归 fiber 直接管）。
    const disposables: Disposable[] = []
    let disposing = false
    let disposalTask: void | Promise<void>
    // dispose 是幂等的：第一次调用开始清理并返回清理任务，之后再调用
    // 只返回同一个任务。清理按注册逆序、一个接一个地串行执行。
    const dispose = () => {
      if (disposing) return disposalTask
      disposing = true
      let task!: void | Promise<void>
      for (const disposable of disposables.splice(0).reverse()) {
        if (task) {
          task = task.then(() => runDisposable(disposable))
        } else {
          const result = runDisposable(disposable)
          if (isObject(result) && 'then' in result) {
            task = result as any
          }
        }
      }
      return disposalTask = task
    }

    const meta: EffectMeta = { label, children: [] }
    const runner: EffectRunner<boolean> = {
      execute,
      epoch: true,
      collect: (dispose) => {
        disposables.push(dispose)
        this._disposables.delete(dispose)
        if (dispose[symbols.effect]) {
          meta.children.push(dispose[symbols.effect])
        }
      },
      getOuterStack: buildOuterStack(),
    }

    let task: void | Promise<void>
    let executing = true
    let resolveSetup: (() => void) | undefined
    let rejectSetup: ((reason: unknown) => void) | undefined
    let setupBarrier: Promise<void> | undefined
    let setupFailed = false
    let inFlight: void | Promise<void>
    let removeWrapper = () => false

    // setupBarrier：execute() 同步执行期间如果发生了重入的卸载，卸载方
    // 需要先等 execute() 本身跑完（拿到 task），才能安全开始清理。
    const waitForSetup = () => {
      setupBarrier ??= new Promise<void>((resolve, reject) => {
        resolveSetup = resolve
        rejectSetup = reject
      })
      return setupBarrier
    }

    // 等某个前置任务 settle 之后再清理；前置任务失败时也照样清理，
    // 然后把失败原因继续抛出去。
    const disposeAfter = (setup: PromiseLike<void>) => {
      return Promise.resolve(setup).then(
        () => dispose(),
        async (reason) => {
          await dispose()
          throw reason
        },
      )
    }

    // 收尾一段清理工作：无论同步抛错、异步 settle 还是同步返回，都保证
    // 把 wrapper 从 fiber 的清理列表里摘掉；异步任务记入 inFlight，让
    // effectInertia 的"搭车者"能等它结束。
    const finalizeDisposal = (callback: () => void | Promise<void>) => {
      let result: void | Promise<void>
      try {
        result = callback()
      } catch (error) {
        removeWrapper()
        throw error
      }
      if (isObject(result) && 'then' in result) {
        const pending = Promise.resolve(result).finally(() => {
          removeWrapper()
          if (inFlight === pending) inFlight = undefined
        })
        return inFlight = pending
      }
      removeWrapper()
      return result
    }

    const wrapper = defineProperty(() => {
      // 同步 setup 失败可能和一次"已经捕获了本 wrapper、但还没来得及
      // 调用它"的拥有者卸载发生竞态。失败的 effect 永远不会被公开返回，
      // 所以这里让那位内部调用方能等到回滚完成（inFlight）。
      if (!runner.epoch) return setupFailed ? inFlight : undefined
      runner.epoch = false
      return finalizeDisposal(() => {
        if (executing) return disposeAfter(waitForSetup())
        return task ? disposeAfter(task) : dispose()
      })
    }, symbols.effect, meta) as AsyncDisposable
    effectInertia.set(wrapper, () => inFlight)

    // 在 execute() 运行任何插件代码之前，先把 wrapper 挂进 fiber 的清理
    // 列表，让重入的拥有者卸载能"看见"这个 effect。异步清理在彻底结束前
    // 一直保持对拥有者可见，外层 effect 因此能搭车加入别人已经开始的清理。
    removeWrapper = this._disposables.push(wrapper)
    try {
      task = this._execute(runner)
    } catch (reason) {
      // execute() 同步抛错：登记为 setup 失败、回滚已经收集的清理函数、
      // 唤醒等在 setupBarrier 上的人，然后把原错误抛给调用方。
      executing = false
      setupFailed = true
      runner.epoch = false
      let cleanup: void | Promise<void>
      try {
        cleanup = finalizeDisposal(dispose)
      } finally {
        rejectSetup?.(reason)
      }
      if (isObject(cleanup) && 'then' in cleanup) {
        cleanup.catch(error => this.ctx.logger.error(error))
      }
      throw reason
    }
    executing = false
    if (setupBarrier) {
      Promise.resolve(task).then(resolveSetup, rejectSetup)
    }

    // 防止未处理的 Promise 拒绝——既防 `task` 自身的拒绝，也防
    // 清理链条没能干净 settle 时的拒绝。
    task?.catch(() => {
      if (!runner.epoch) return dispose()
      return finalizeDisposal(dispose)
    }).catch((error) => this.ctx.logger.error(error))

    // wrapper 同时是"函数"和"PromiseLike"：调 wrapper() 直接开始清理；
    // await wrapper 则等 setup 完成后拿到 disposeAsync。
    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return finalizeDisposal(dispose)
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    return wrapper
  }

  /**
   * 返回当前仍在登记的 effect 的元数据。
   *
   * @returns 每个带标签的存活 effect 对应一棵 {@link EffectMeta} 树。
   */
  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>(dispose => dispose[symbols.effect])
      .filter(Boolean)
  }

  // 从底层标志推算当前状态：uid 清空即 DISPOSED；有错误即 FAILED；
  // epoch 不是 INACTIVE 说明插件处于激活状态；否则还在等依赖（PENDING）。
  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  // 状态迁移的统一入口：先执行回调（回调可直接指定新状态，比如 LOADING），
  // 否则按 _getState() 推算；状态真的变了才广播 internal/status。
  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    // FIXME internal/fiber-info 待补充的细粒度通知事件
    this.context.emit('internal/status', this, oldState)

    // 只在 ACTIVE 与非 ACTIVE 之间切换时，才通知服务消费者刷新
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    // 遍历本 fiber 提供的服务实现，通知 reflect 层刷新访问器，
    // 让 ctx.xxx 的读写跟随插件的激活/失活切换。
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key as symbol]
      if (impl.fiber !== this) continue
      this.ctx.reflect.notify([impl.name])
    }
  }

  // 检查某个依赖服务当前是否可用：实现不存在、check 谓词不通过或
  // check 自身抛错，都视为不可用（从 _store 删除）；可用则登记进 _store。
  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.fiber.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  // 根据依赖满足情况算出新的 epoch：有任何一个依赖缺失就是 INACTIVE；
  // 全部满足时，epoch 是各依赖提供者 uid 拼出的"指纹"——任何依赖被
  // 重载（提供者 uid 变化）都会改变指纹，从而触发本 fiber 重载。
  _refresh() {
    let epoch: string | boolean = false
    epoch = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }

  // 应用新的 epoch：没变就直接返回；已有迁移在进行时只更新标记，由
  // 进行中的迁移收尾时根据 epoch 决定下一步（见 _reload/_unload 末尾）。
  // 从 INACTIVE 变为有效指纹 → 加载；反之 → 卸载。
  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    this._runner.epoch = epoch
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  // 先过 internal/config 瀑布（监听器可改写配置），再按 schema 校验。
  private _resolveConfig(config: any) {
    config = this.context.waterfall(this, 'internal/config', config, () => config)
    return this.runtime ? resolveConfig(this.runtime, config) : config
  }

  // 加载流程：快照依赖 → 校验配置 → 执行插件回调。
  // 期间 epoch 若被改写（依赖又变了、或被要求卸载），收尾时改为转卸载。
  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      // 在这个检查点之前排队的 disposer 可能已经让这次加载失效了。
      // 不要为过期的 epoch 执行插件代码；下面的状态更新会排空 fiber
      // 处于 PENDING 期间收集到的 effect。
      if (this._runner.epoch === oldEpoch) {
        this.config = this._resolveConfig(this._config)
        await this._execute(this._runner)
        this._error = undefined
      }
    } catch (reason) {
      // 按约定 reason 保证非空
      this.ctx.logger.error(reason)
      this._error = reason
      this._runner.epoch = INACTIVE
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  // 卸载流程：取出清理列表（逆序）并并行执行所有清理函数；单个清理
  // 抛错只记日志，不中断其他清理。收尾时若 epoch 已被重新激活，
  // 就接力进入一次新的加载。
  private async _unload() {
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve()
          info.error = new Error()
          await runDisposable(dispose)
        }, this._runner.getOuterStack)
      } catch (reason) {
        this.ctx.logger.error(reason)
      }
    }))
    this.store = undefined
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  /**
   * 等当前的生命周期工作全部结束，并重新抛出启动阶段的错误。
   *
   * @returns 状态稳定后的本 fiber。
   * @throws 配置校验或插件启动的错误（如果有）。
   */
  async await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
    return this
  }

  /**
   * 销毁并用当前配置立即重新加载这个插件。
   *
   * @returns 一个 promise，在重载稳定后 resolve。
   * @throws {CordisError} fiber 已销毁时抛出 `INACTIVE_EFFECT`。
   */
  async restart() {
    this.assertActive()
    this._setEpoch(INACTIVE)
    this._refresh()
    await this.await()
  }

  /**
   * 校验并应用新配置，然后重启插件。
   *
   * 先走 `internal/update` 瀑布，更新钩子（以及热更新 HMR）可以否决
   * 或替换掉这次重启。
   *
   * @param config — 新的原始配置；在任何重启发生前先校验。
   * @param noSave — 提示持久化钩子不要把这次改动写回存储。
   * @returns 更新瀑布的结果；默认的重启分支返回一个 promise。
   * @throws 校验、更新监听器或重启后的插件失败时抛出。
   */
  update(config: any, noSave = false) {
    this.assertActive()
    this._config = config
    if (this.state !== FiberState.ACTIVE) {
      // 配置解析可能访问注入的服务，所以推迟到 fiber 能激活时再做。
      this._error = undefined
      this._setEpoch(INACTIVE)
      this._refresh()
      return
    }
    config = this._resolveConfig(config)
    return this.context.waterfall(this, 'internal/update', config, noSave, () => {
      this.config = config
      this._error = undefined
      return this.restart()
    })
  }
}
