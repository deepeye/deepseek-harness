/**
 * The service command-line provider over a real Loader tree: its ordinary
 * service releases a consumer whose config reads `ctx.serviceStartup`
 * directly.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, SERVICE_STARTUP_SERVICE, type ServiceStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  readerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/** The environment variables around one test; stubbed empty by default. */
const ENV_HOST = 'DSH_SERVICE_HOST'
const ENV_PORT = 'DSH_SERVICE_PORT'

beforeEach(() => {
  vi.stubEnv(ENV_HOST, '')
  vi.stubEnv(ENV_PORT, '')
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  vi.unstubAllEnvs()
})

/**
 * Mount the real provider and a consumer using injection-ordered config.
 * @param args - the invocation's inner arguments.
 * @returns the service value and observed consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: ServiceStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-service-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__serviceStartupObserved.readerConfig = config }
`)
  // Node imports the fixture row outside Vite's source resolver, so delegate
  // to the source-plane plugin already imported by this test.
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'service-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__serviceStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${SERVICE_STARTUP_SERVICE}]`,
    '  config:',
    '    host: !!js ctx.serviceStartup.host',
    '    port: !!js ctx.serviceStartup.port',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __serviceStartupApply: typeof apply
    __serviceStartupObserved: Observed
  }
  globals.__serviceStartupApply = apply
  globals.__serviceStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(SERVICE_STARTUP_SERVICE) as ServiceStartupValues | undefined,
    observed,
  }
}

describe('service command-line provider', () => {
  it('resolves both flags, releases direct service expressions, and warns on an all-interfaces bind', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--port', '18923'])
    expect(values).toEqual({ host: '0.0.0.0', port: 18923 })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.out).toContain('--host 0.0.0.0 exposes the task service to the network')
    expect(observed.out).toContain('TLS-terminating reverse proxy')
    expect(observed.exits).toEqual([])
  })

  it('falls back to the loopback default when flags and environment omit values', async () => {
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ host: '127.0.0.1', port: 0 })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.out).not.toContain('exposes the task service')
    expect(observed.exits).toEqual([])
  })

  it('falls back to the deployment environment and warns on an all-interfaces bind', async () => {
    vi.stubEnv(ENV_HOST, '0.0.0.0')
    vi.stubEnv(ENV_PORT, '18923')
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ host: '0.0.0.0', port: 18923 })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.out).toContain('--host 0.0.0.0 exposes the task service to the network')
    expect(observed.exits).toEqual([])
  })

  it('lets the invocation flag override the deployment environment', async () => {
    vi.stubEnv(ENV_HOST, '0.0.0.0')
    vi.stubEnv(ENV_PORT, '18923')
    const { values, observed } = await bootProvider(['--port', '8080'])
    expect(values).toEqual({ host: '0.0.0.0', port: 8080 })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.exits).toEqual([])
  })

  it('reads an empty environment value as unset', async () => {
    vi.stubEnv(ENV_HOST, '')
    vi.stubEnv(ENV_PORT, '')
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ host: '127.0.0.1', port: 0 })
    expect(observed.exits).toEqual([])
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile service')
    expect(observed.out).toContain('--host')
    expect(observed.out).toContain('--port')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a host outside the two supported literals before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--host', '192.168.1.5'])
    expect(observed.out).toContain('--host must be 127.0.0.1 or 0.0.0.0, got "192.168.1.5"')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number, got "abc"')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an invalid deployment-environment host before the consumer activates', async () => {
    vi.stubEnv(ENV_HOST, 'localhost')
    const { values, observed } = await bootProvider([])
    expect(observed.out).toContain('DSH_SERVICE_HOST must be 127.0.0.1 or 0.0.0.0, got "localhost"')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a non-numeric deployment-environment port before the consumer activates', async () => {
    vi.stubEnv(ENV_PORT, 'abc')
    const { values, observed } = await bootProvider([])
    expect(observed.out).toContain('DSH_SERVICE_PORT must be a number, got "abc"')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
