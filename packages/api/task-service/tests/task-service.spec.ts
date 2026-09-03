/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the webserver, agent spine, DeepSeek adapter (against a
 * keyless mock provider), and the task-service row. Every assertion observes
 * the user-visible HTTP surface: bearer rejection, task submission, SSE
 * progress frames, result queries, cancellation, and webhook delivery.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { startMockLlmServer, type MockLlmBehavior, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import TaskService from '../src/index.ts'

const TOKEN = 'test-bearer-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let root: string | undefined
let context: Context | undefined
let mock: MockLlmServer | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await mock?.close()
  mock = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Boot one task-service composition against one mock provider script. */
async function loadComposition(sequence: readonly MockLlmBehavior[], token = TOKEN): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-service-'))
  vi.stubEnv('DSH_TASK_SERVICE_TEST_KEY', 'mock-key')
  mock = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence,
    repeatLast: true,
    successText: 'TASK SERVICE OK',
  })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: agent-spine',
    "  name: '@deepseek-ai/dsh-agent-spine-demo'",
    '  config:',
    '    persona: You are a task fixture.',
    '    includeHarnessIdentity: false',
    '    includeRuntimeContext: false',
    '    workspaceContext: false',
    '    skills:',
    '      enabled: false',
    '    toolBash: false',
    '    toolJobs: false',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-v4-flash',
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    '  config:',
    `    baseURL: ${JSON.stringify(mock.baseURL)}`,
    '    apiKeyEnv: DSH_TASK_SERVICE_TEST_KEY',
    '- id: task-service',
    "  name: '@deepseek-ai/dsh-task-service'",
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    '    webhookTimeoutMs: 1000',
    '    webhookRetries: 1',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-agent-spine-demo', AgentSpine],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
    ['@deepseek-ai/dsh-task-service', TaskService],
  ])
  // Mirror the package manifests a deployed cordis.yml has beside its declared
  // dependencies; the custom importer bypasses Node resolution for the sources.
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(root!, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: '0.1.2-alpha.2',
      type: 'module',
    })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

/** Listening base URL of the composed webserver row. */
function baseUrl(ctx: Context): string {
  const server = ctx.get('webServer')!
  return `http://127.0.0.1:${String(server.port)}`
}

/** POST one task submission and return the wire response. */
async function submit(ctx: Context, body: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return fetch(`${baseUrl(ctx)}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

/** Read one SSE response body to completion and return its decoded text. */
async function readSse(url: string, headers: Record<string, string> = AUTH): Promise<string> {
  const response = await fetch(url, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/** Start one local capture server for webhook deliveries. */
async function startWebhookCapture(): Promise<{
  url: string
  nextBody: Promise<string>
  close: () => Promise<void>
}> {
  let resolveDone: ((value: string) => void) | undefined
  const nextBody = new Promise<string>((resolve) => { resolveDone = resolve })
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = ''
    req.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    req.on('end', () => {
      resolveDone?.(text)
      res.writeHead(200)
      res.end()
    })
  })
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`)
    })
  })
  return {
    url,
    nextBody,
    close: () => new Promise((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error) }) }),
  }
}

describe('real Loader composition', () => {
  it('rejects requests without or with a wrong bearer token', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const missing = await submit(ctx, JSON.stringify({ task: 'hi' }), {})
    expect(missing.status).toBe(401)
    const wrong = await submit(ctx, JSON.stringify({ task: 'hi' }), { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
    const unknown = await fetch(`${baseUrl(ctx)}/tasks/does-not-exist`, { headers: AUTH })
    expect(unknown.status).toBe(404)
  })

  it('rejects an empty token at load', () => {
    expect(() => TaskService.Config({ token: '' })).toThrow()
  })

  it('completes a submitted task and serves its result', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const response = await submit(ctx, JSON.stringify({ task: 'Say the fixture phrase.' }))
    expect(response.status).toBe(202)
    const { taskId } = await response.json() as { taskId: string }
    expect(taskId).toMatch(/^session-/)

    await vi.waitFor(async () => {
      const status = await fetch(`${baseUrl(ctx)}/tasks/${taskId}`, { headers: AUTH })
      const body = await status.json() as { status: string; result?: { text: string; reason: { kind: string } } }
      expect(body.status).toBe('finished')
      expect(body.result?.text).toBe('TASK SERVICE OK')
      expect(body.result?.reason.kind).toBe('completed')
    }, { timeout: 30_000 })
  })

  it('streams session events as SSE until the terminating turn/end', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const { taskId } = await (await submit(ctx, JSON.stringify({ task: 'Say the fixture phrase.' }))).json() as { taskId: string }
    const text = await readSse(`${baseUrl(ctx)}/tasks/${taskId}/events`)
    const events = text.split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)) as { type: string })
    const types = events.map(event => event.type)
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types.at(-1)).toBe('turn/end')
  })

  it('delivers the final result to the per-task webhook URL', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const capture = await startWebhookCapture()
    try {
      const response = await submit(ctx, JSON.stringify({ task: 'Say the fixture phrase.', webhookUrl: capture.url }))
      const { taskId } = await response.json() as { taskId: string }
      const body = JSON.parse(await capture.nextBody) as {
        taskId: string
        status: string
        result: { text: string; reason: { kind: string } }
      }
      expect(body.taskId).toBe(taskId)
      expect(body.status).toBe('finished')
      expect(body.result.text).toBe('TASK SERVICE OK')
      expect(body.result.reason.kind).toBe('completed')
    } finally {
      await capture.close()
    }
  })

  it('cancels a stalled task and reports the aborted turn', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['stall'])
    const { taskId } = await (await submit(ctx, JSON.stringify({ task: 'Never finishes.' }))).json() as { taskId: string }
    await vi.waitFor(() => {
      expect(mock?.requests.length ?? 0).toBeGreaterThan(0)
    }, { timeout: 30_000 })
    const cancel = await fetch(`${baseUrl(ctx)}/tasks/${taskId}/cancel`, { method: 'POST', headers: AUTH })
    expect(cancel.status).toBe(202)
    await vi.waitFor(async () => {
      const status = await fetch(`${baseUrl(ctx)}/tasks/${taskId}`, { headers: AUTH })
      const body = await status.json() as { status: string; result?: { reason: { kind: string } } }
      expect(body.status).toBe('finished')
      expect(body.result?.reason.kind).toBe('aborted')
    }, { timeout: 30_000 })
    const again = await fetch(`${baseUrl(ctx)}/tasks/${taskId}/cancel`, { method: 'POST', headers: AUTH })
    expect(again.status).toBe(409)
  })
})
