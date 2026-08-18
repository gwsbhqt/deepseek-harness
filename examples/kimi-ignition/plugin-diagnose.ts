/**
 * plugin-diagnose —— 手动回放 self-1（ESM 版）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'plugin-diagnose'
export const inject = ['dynamicCordisRunner', 'agents']

export function apply(ctx: Context) {
  const timer = setTimeout(async () => {
    try {
      const rec = JSON.parse(readFileSync(resolve('./.dynplugins/ignition-main--self-1.json'), 'utf8'))
      const pkg = rec.packages.find((p: any) => p.packageId === rec.activePackage) ?? rec.packages.at(-1)
      console.log('[diagnose] 选中包:', pkg.packageId, '| label:', pkg.label, '| host 代码长度:', pkg.code.host?.length)
      const agent = (ctx as any).agents.get('ignition-main')
      const runner = (ctx as any).dynamicCordisRunner
      const receipt = runner.define({
        sessionId: rec.sessionId,
        plugin: { kind: 'new', idPrefix: rec.pluginId },
        name: pkg.label,
        purpose: rec.purpose,
        code: pkg.code,
      })
      console.log('[diagnose] define 回执:', receipt.pluginId, receipt.packageId)
      const r = await runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
      console.log('[diagnose] run 结果:', JSON.stringify(r).slice(0, 200))
    } catch (e) {
      console.log('[diagnose] 回放失败:', (e as Error).message)
    }
  }, 1500)
  ctx.effect(() => () => clearTimeout(timer), 'plugin-diagnose: timer')
}
