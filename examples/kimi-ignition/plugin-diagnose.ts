/**
 * plugin-diagnose —— v10：把 harness 发往 api.kimi.com 的完整请求体落盘到
 * os.tmpdir()/kimi-req-N.json（落仓库外，避免触发 hmr 自激）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'

export const name = 'plugin-diagnose'
let n = 0

export function apply(ctx: Context) {
  const orig = globalThis.fetch
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url
    if (!url?.includes('api.kimi.com') || !init?.body) return orig(input, init)
    try {
      writeFileSync(`${tmpdir()}/kimi-req-${++n}.json`, init.body)
      console.log(`[diagnose] dumped kimi-req-${n}.json`)
    } catch { /* 落盘失败不影响请求 */ }
    return orig(input, init)
  }
  ctx.effect(() => () => { globalThis.fetch = orig }, 'plugin-diagnose: unwrap fetch')
}
