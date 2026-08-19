import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin-dynpersist.ts'

const originalCwd = process.cwd()
const cleanups: string[] = []

afterEach(() => {
  process.chdir(originalCwd)
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

describe('dynamic plugin persistence', () => {
  it('replays an active plugin when its agent is registered after startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dynpersist-'))
    cleanups.push(root)
    process.chdir(root)
    mkdirSync('.dynplugins')
    writeFileSync('.dynplugins/self-evolution-main--self-2.json', JSON.stringify({
      pluginId: 'self-2',
      idPrefix: 'self',
      purpose: 'preserve the self-evolution helper',
      sessionId: 'self-evolution-main',
      packages: [{ packageId: 'pkg-3', label: 'self helper', code: { host: 'export default {}' } }],
      activePackage: 'pkg-3',
    }))

    const listeners = new Map<string, (...args: unknown[]) => void>()
    const agent = { id: 'self-evolution-main' }
    const runner = {
      snapshot: vi.fn(() => []),
      define: vi.fn(() => ({ pluginId: 'self-3', packageId: 'pkg-4', name: 'self helper' })),
      run: vi.fn(async () => ({ ok: true })),
    }
    let published = false
    const ctx = {
      dynamicCordisRunner: runner,
      agents: { get: vi.fn(() => published ? agent : undefined) },
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
      }),
    } as unknown as Context

    apply(ctx)
    expect(runner.define).not.toHaveBeenCalled()

    published = true
    listeners.get('agent/created')?.({ agent })

    await vi.waitFor(() => {
      expect(runner.run).toHaveBeenCalled()
    })

    expect(runner.define).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'self-evolution-main',
      plugin: { kind: 'new', idPrefix: 'self' },
    }))
    expect(runner.run).toHaveBeenCalledWith(agent, 'self-3', 'pkg-4', 'run')
    expect(JSON.parse(readFileSync('.dynplugins/self-evolution-main--self-2.json', 'utf8')))
      .toMatchObject({ pluginId: 'self-3', activePackage: 'pkg-4' })
  })

  it('keeps an active record eligible for retry when replay fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dynpersist-'))
    cleanups.push(root)
    process.chdir(root)
    mkdirSync('.dynplugins')
    const path = '.dynplugins/self-evolution-main--self-2.json'
    writeFileSync(path, JSON.stringify({
      pluginId: 'self-2',
      idPrefix: 'self',
      purpose: 'preserve the self-evolution helper',
      sessionId: 'self-evolution-main',
      packages: [{ packageId: 'pkg-3', label: 'self helper', code: { host: 'export default {}' } }],
      activePackage: 'pkg-3',
    }))

    const agent = { id: 'self-evolution-main' }
    const runner = {
      snapshot: vi.fn(() => []),
      define: vi.fn(() => {
        throw new Error('temporary replay failure')
      }),
    }
    const ctx = {
      dynamicCordisRunner: runner,
      agents: { get: vi.fn(() => agent) },
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(),
    } as unknown as Context

    apply(ctx)
    await vi.waitFor(() => {
      expect(runner.define).toHaveBeenCalled()
    })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ activePackage: 'pkg-3' })
  })
})
