/** Self-evolution Web composition policy over the runnable cordis.yml. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const jsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string): string => value,
})
const schema = yaml.JSON_SCHEMA.extend(jsExpression)

/** Package specifiers declared by the runnable self-evolution composition. */
function configuredPackages(): Set<string> {
  const document: unknown = yaml.load(readFileSync(configPath, 'utf8'), { schema })
  if (!Array.isArray(document)) throw new TypeError('self-evolution cordis.yml must be a Loader entry array')
  return new Set(document.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry)) return []
    const name = (entry as { name?: unknown }).name
    return typeof name === 'string' ? [name] : []
  }))
}

describe('self-evolution Web composition', () => {
  it('provides conversation, trajectory, and dynamic Cordis inspection', () => {
    const packages = configuredPackages()
    expect([
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-trajectory',
      '@deepseek-ai/dsh-client-ui-cordis',
    ].filter(name => !packages.has(name))).toEqual([])
  })

  it('omits the generic Settings and Loader inventory surfaces', () => {
    const packages = configuredPackages()
    expect([...packages].filter(name => [
      '@deepseek-ai/dsh-client-ui-settings-general',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
      '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
      '@deepseek-ai/dsh-host-plugin-inventory',
    ].includes(name))).toEqual([])
  })

  it('uses the native directory picker without the adaptive loader', () => {
    const packages = configuredPackages()
    expect([
      '@deepseek-ai/dsh-host-directory-picker-native',
      '@deepseek-ai/dsh-client-ui-directory-picker-native',
    ].filter(name => !packages.has(name))).toEqual([])
    expect(packages.has('@deepseek-ai/dsh-host-directory-picker-auto')).toBe(false)
  })
})
