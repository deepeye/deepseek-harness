/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the webserver, agent spine, DeepSeek adapter (against a
 * keyless mock provider), and the task-service row. Every assertion observes
 * the user-visible HTTP surface: bearer rejection, task submission, SSE
 * progress frames, result queries, cancellation, and webhook delivery.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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

/** Options for {@link loadComposition}. */
interface CompositionOptions {
  /** Bearer token; defaults to the shared test token. */
  readonly token?: string
  /** Compose `session-persistence-jsonl` + the checkpoint policy so sessions durably persist. */
  readonly persistent?: boolean
  /** Reuse an existing mkdtemp root (cold-resume context B shares context A's persistence). */
  readonly reuseRoot?: string
  /** Override the task-service `workspaceRoot` (cwd-conflict: A and B mint different session cwds). */
  readonly workspaceRoot?: string
}

/** Boot one task-service composition against one mock provider script. */
async function loadComposition(
  sequence: readonly MockLlmBehavior[],
  options: CompositionOptions = {},
): Promise<Context> {
  const { token = TOKEN, persistent = false, reuseRoot, workspaceRoot } = options
  root = reuseRoot ?? await mkdtemp(join(tmpdir(), 'dsh-task-service-'))
  vi.stubEnv('DSH_TASK_SERVICE_TEST_KEY', 'mock-key')
  mock = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence,
    repeatLast: true,
    successText: 'TASK SERVICE OK',
  })

  const workspaces = workspaceRoot ?? join(root, 'workspaces')
  const lines: string[] = [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: agent-loop',
    "  name: '@deepseek-ai/dsh-agent-loop'",
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
  ]
  if (persistent) {
    lines.push(
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    )
  }
  lines.push(
    '- id: session-query-sqlite',
    "  name: '@deepseek-ai/dsh-session-query-sqlite'",
    '  config:',
    "    path: ':memory:'",
    '    openAt: never',
    '- id: task-service',
    "  name: '@deepseek-ai/dsh-task-service'",
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    `    workspaceRoot: ${JSON.stringify(workspaces)}`,
    '    webhookTimeoutMs: 1000',
    '    webhookRetries: 1',
    '',
  )
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, lines.join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
    ['@deepseek-ai/dsh-task-service', TaskService],
    ['@deepseek-ai/dsh-session-query-sqlite', SessionQuerySqlite],
  ])
  if (persistent) modules.set('@deepseek-ai/dsh-session-persistence-jsonl', SessionPersistenceJsonl)
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
  // The checkpoint policy is a function plugin (named `name`/`inject`/`apply`,
  // no class default export); the Loader's importer serves class services, so
  // apply it directly once the loader composition has resolved its
  // `llm`/`sessionPersistence`/`sessions`/`tools` injections.
  if (persistent) await ctx.plugin(SessionCheckpointPolicy)
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

  it('rejects a submission without a task field', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const response = await submit(ctx, JSON.stringify({ webhookUrl: 'https://example.com/hook' }))
    expect(response.status).toBe(400)
  })

  it('rejects a non-http webhookUrl', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const response = await submit(ctx, JSON.stringify({ task: 'hi', webhookUrl: 'ftp://example.com/hook' }))
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain('webhookUrl')
  })

  it('completes a submitted task and serves its result', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const response = await submit(ctx, JSON.stringify({ task: 'Say the fixture phrase.' }))
    expect(response.status).toBe(202)
    const { taskId, sessionId } = await response.json() as { taskId: string; sessionId: string }
    expect(taskId).toMatch(/^task-/)
    expect(sessionId).toMatch(/^session-/)

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

  it('continues a multi-turn conversation within one Host context', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const sid = 'multi-turn-session'
    const r1 = await submit(ctx, JSON.stringify({ task: 'first turn marker', sessionId: sid }))
    expect(r1.status).toBe(202)
    const { taskId: t1, sessionId: s1 } = await r1.json() as { taskId: string; sessionId: string }
    expect(s1).toBe(sid)
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctx)}/tasks/${t1}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
    // Second turn on the same session: the live idle agent is adopted, and the
    // new turn follows the first in the same conversation log.
    const r2 = await submit(ctx, JSON.stringify({ task: 'second turn marker', sessionId: sid }))
    expect(r2.status).toBe(202)
    const { taskId: t2 } = await r2.json() as { taskId: string; sessionId: string }
    expect(t2).not.toBe(t1)
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctx)}/tasks/${t2}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
    // Live-agent adoption proof: the second LLM request carries the first turn.
    const wire = JSON.stringify(mock!.requests.at(-1)?.body ?? {})
    expect(wire).toContain('first turn marker')
    expect(wire).toContain('second turn marker')
  })

  it('isolates each conversation under its own working directory', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['success'])
    const r1 = await submit(ctx, JSON.stringify({ task: 'a', sessionId: 'iso-a' }))
    const r2 = await submit(ctx, JSON.stringify({ task: 'b', sessionId: 'iso-b' }))
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    const cwdA = join(root!, 'workspaces', 'iso-a')
    const cwdB = join(root!, 'workspaces', 'iso-b')
    // Each conversation's working directory is materialized on session
    // resolution, before the 202 acknowledges the task.
    await expect(stat(cwdA)).resolves.toBeDefined()
    await expect(stat(cwdB)).resolves.toBeDefined()
    expect(cwdA).not.toBe(cwdB)
  })

  it('rejects a second task against a session whose turn is still running', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition(['stall'])
    const sid = 'busy-session'
    const r1 = await submit(ctx, JSON.stringify({ task: 'never finishes', sessionId: sid }))
    expect(r1.status).toBe(202)
    const { taskId: t1 } = await r1.json() as { taskId: string; sessionId: string }
    // The stall never resolves, so the turn stays running; a second task
    // targeting the same conversation is rejected before session resolution.
    const r2 = await submit(ctx, JSON.stringify({ task: 'second', sessionId: sid }))
    expect(r2.status).toBe(409)
    expect((await r2.json() as { error: string }).error).toBe('session/agent-busy')
    // Cancel the stalled turn so the context can tear down cleanly.
    const cancel = await fetch(`${baseUrl(ctx)}/tasks/${t1}/cancel`, { method: 'POST', headers: AUTH })
    expect(cancel.status).toBe(202)
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctx)}/tasks/${t1}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
  })

  it('cold-resumes a persisted conversation across two Host contexts', { timeout: 60_000 }, async () => {
    const ctxA = await loadComposition(['success'], { persistent: true })
    const sid = 'cold-resume-session'
    const r1 = await submit(ctxA, JSON.stringify({ task: 'first turn marker', sessionId: sid }))
    expect(r1.status).toBe(202)
    const { taskId: t1 } = await r1.json() as { taskId: string; sessionId: string }
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctxA)}/tasks/${t1}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
    // Flush the complete turn to durability before tearing down context A.
    const liveAgent = ctxA.agents.get(SessionId(sid))
    if (liveAgent !== undefined) await ctxA.sessions.flush(liveAgent.session)
    const sharedRoot = root!
    await ctxA.fiber.dispose()
    context = undefined
    await mock!.close()
    mock = undefined

    // Context B shares A's persistence root; the service cold-resumes the
    // session from the durable log before queuing the second turn.
    const ctxB = await loadComposition(['success'], { persistent: true, reuseRoot: sharedRoot })
    const r2 = await submit(ctxB, JSON.stringify({ task: 'second turn marker', sessionId: sid }))
    expect(r2.status).toBe(202)
    const { taskId: t2 } = await r2.json() as { taskId: string; sessionId: string }
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctxB)}/tasks/${t2}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
    // Cold-resume proof: B's LLM request carries the first turn's history.
    const wire = JSON.stringify(mock!.requests.at(-1)?.body ?? {})
    expect(wire).toContain('first turn marker')
    expect(wire).toContain('second turn marker')
  })

  it('rejects a persisted session whose recorded cwd differs from the service-minted one', { timeout: 60_000 }, async () => {
    const ctxA = await loadComposition(['success'], { persistent: true })
    const sid = 'cwd-conflict-session'
    const r1 = await submit(ctxA, JSON.stringify({ task: 'seed the conversation', sessionId: sid }))
    expect(r1.status).toBe(202)
    const { taskId: t1 } = await r1.json() as { taskId: string; sessionId: string }
    await vi.waitFor(async () => {
      const s = await fetch(`${baseUrl(ctxA)}/tasks/${t1}`, { headers: AUTH })
      expect((await s.json() as { status: string }).status).toBe('finished')
    }, { timeout: 30_000 })
    const liveAgent = ctxA.agents.get(SessionId(sid))
    if (liveAgent !== undefined) await ctxA.sessions.flush(liveAgent.session)
    const sharedRoot = root!
    await ctxA.fiber.dispose()
    context = undefined
    await mock!.close()
    mock = undefined

    // Context B shares A's persistence root but mints a different session cwd
    // (different workspaceRoot), so the persisted header's cwd no longer matches.
    const ctxB = await loadComposition(['success'], {
      persistent: true,
      reuseRoot: sharedRoot,
      workspaceRoot: join(sharedRoot, 'workspaces-b'),
    })
    const r2 = await submit(ctxB, JSON.stringify({ task: 'resume here', sessionId: sid }))
    expect(r2.status).toBe(409)
    const body = await r2.json() as { error: string; sessionId: string }
    expect(body.error).toBe('session/cwd-conflict')
    expect(body.sessionId).toBe(sid)
  })
})
