/**
 * plugin-diagnose —— 包壳确诊：写前后各读一次 prototype 与实例属性。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'plugin-diagnose'
export const inject = ['dynamicCordisRunner']

export function apply(ctx: Context) {
  const timer = setTimeout(() => {
    const runner: any = (ctx as any).dynamicCordisRunner
    const proto = Object.getPrototypeOf(runner)
    console.log('[diagnose] proto.define 含包壳标记:', String(proto.define).includes('replaying'))
    console.log('[diagnose] 实例自有 define 含包壳标记:', Object.prototype.hasOwnProperty.call(runner, 'define') ? String(Object.getOwnPropertyDescriptor(runner, 'define')!.value).includes('replaying') : '(无自有属性)')
    const protoDesc = Object.getOwnPropertyDescriptor(proto, 'define')
    console.log('[diagnose] proto define descriptor: writable=', protoDesc?.writable, 'configurable=', protoDesc?.configurable)
    // 写测试：赋一个标记函数再读回
    const orig = runner.define
    runner.define = function wrapped() { return orig.apply(this, arguments) }
    console.log('[diagnose] 赋实例属性后 ownDescriptor 存在:', Object.prototype.hasOwnProperty.call(runner, 'define'))
    console.log('[diagnose] 赋后读回是包装函数:', String(runner.define).includes('wrapped'))
    delete runner.define
    console.log('[diagnose] delete 后读回是原型方法:', String(runner.define).includes('replaying') || !String(runner.define).includes('wrapped'))
  }, 1500)
  ctx.effect(() => () => clearTimeout(timer), 'plugin-diagnose: timer')
}
