/**
 * @deepseek-ai/dsh-task-service — remote task HTTP surface over the harness
 * core. Each task is one Agent session driven by a single prompt: submission
 * creates the agent and queues the prompt, the session log is the durable
 * record, and the HTTP routes project progress (SSE), results, and
 * cancellation. The service owns no agent-loop behavior.
 *
 * @module @deepseek-ai/dsh-task-service
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote task submission surface. */
    taskService: TaskService
  }
}

/** Why one task's turn ended, exactly as the session log records it. */
type TaskEndReason = SessionEvent<'turn/end'>['data']['reason']

/** Final task outcome served by the result and webhook surfaces. */
export interface TaskResult {
  /** Final assistant text: every text block of the turn's `assistant/message` events joined. */
  readonly text: string
  /** Durable `turn/end` reason. */
  readonly reason: TaskEndReason
}

/** Wire status of one task. */
export type TaskStatus = 'running' | 'finished'

/** Task-service configuration. */
export interface Config {
  /**
   * Bearer token every request must present in `Authorization: Bearer <token>`.
   * An empty value fails the load; there is no anonymous mode.
   */
  readonly token: string
  /** Default completion webhook URL, used when a task submits no override. @optional */
  readonly webhookUrl?: string
  /** Per-attempt webhook delivery timeout in milliseconds. @default 10000 */
  readonly webhookTimeoutMs?: number
  /** Webhook redelivery attempts after the first failure. @default 2 */
  readonly webhookRetries?: number
}

interface ResolvedConfig extends Config {
  readonly webhookTimeoutMs: number
  readonly webhookRetries: number
}

interface WebhookDefaults {
  readonly url: string | undefined
  readonly timeoutMs: number
  readonly retries: number
}

/** One submitted task: the owning agent plus its derived status. */
interface TaskRecord {
  readonly taskId: SessionId
  readonly agent: Agent
  /** First session seq this task may observe; earlier events predate the prompt. */
  readonly firstSeq: number
  readonly webhookUrl: string | undefined
  status: TaskStatus
  result: TaskResult | undefined
}

/** Validated `POST /tasks` body. */
const submitRequestSchema = z.object({
  task: z.string().min(1),
  webhookUrl: z.string().min(1).optional(),
})/** Request-body byte cap: a task prompt is text, not a file upload. */
const MAX_TASK_BODY_BYTES = 1024 * 1024

/** Prefix under which every route is served. */
const TASKS_PATH = '/tasks'

/**
 * Serve task submission and observation over the web server. Registrations are
 * effects of this service's fiber: disposing it removes the routes and event
 * subscriptions. The in-memory registry does not survive a restart; finished
 * agents are retained for result queries.
 */
export class TaskService extends Service {
  static inject = ['agentDefaultModel', 'agents', 'webServer']

  /** Validated task-service configuration. */
  static Config: Schema<Config> = Schema.object({
    token: Schema.string().min(1),
    webhookUrl: Schema.string().min(1),
    webhookTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
    webhookRetries: Schema.number().step(1).min(0).max(10).default(2),
  })

  private readonly token: string
  private readonly webhook: WebhookDefaults
  private readonly tasks = new Map<string, TaskRecord>()

  /**
   * Register the task routes and the finish-detection event subscription.
   * @param ctx - owning Host Context with Agent registry and web server access.
   * @param config - validated task-service configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'taskService')
    const resolved = config as ResolvedConfig
    this.token = resolved.token
    this.webhook = {
      url: resolved.webhookUrl,
      timeoutMs: resolved.webhookTimeoutMs,
      retries: resolved.webhookRetries,
    }
    ctx.effect(() => {
      const route: WebRoute = {
        kind: 'prefix',
        path: TASKS_PATH,
        handler: (req, res) => { void this.handle(req, res) },
      }
      return ctx.webServer.register(route)
    }, 'task-service: /tasks routes')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const record = this.tasks.get(String(session.id))
      if (record === undefined || record.status === 'finished') return
      this.finish(record, event)
    }), 'task-service: task finish detection')
  }

  /** Dispatch one authenticated request to its task operation. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerMatches(req.headers.authorization, this.token)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' })
      res.end('unauthorized')
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    try {
      if (req.method === 'POST' && pathname === TASKS_PATH) {
        await this.submit(req, res)
        return
      }
      const rest = pathname === TASKS_PATH ? '' : pathname.startsWith(`${TASKS_PATH}/`)
        ? pathname.slice(TASKS_PATH.length + 1)
        : undefined
      const [taskId, operation] = rest === undefined || rest === ''
        ? [undefined, undefined]
        : rest.split('/')
      if (taskId === undefined || taskId === '' || operation !== undefined && operation !== 'events' && operation !== 'cancel') {
        json(res, 404, { error: 'not found' })
        return
      }
      const record = this.tasks.get(taskId)
      if (record === undefined) {
        json(res, 404, { error: `unknown task ${JSON.stringify(taskId)}` })
        return
      }
      if (req.method === 'GET' && operation === undefined) this.status(record, res)
      else if (req.method === 'GET' && operation === 'events') await this.streamEvents(record, req, res)
      else if (req.method === 'POST' && operation === 'cancel') this.cancel(record, res)
      else json(res, 405, { error: 'method not allowed' })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Read and validate one submission, create its agent, and queue the prompt. */
  private async submit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = submitRequestSchema.safeParse(await readJsonBody(req, MAX_TASK_BODY_BYTES))
    if (!parsed.success) throw new Error('invalid task submission')
    const body = parsed.data
    const webhookUrl = body.webhookUrl ?? this.webhook.url
    if (webhookUrl !== undefined && !isHttpUrl(webhookUrl)) {
      json(res, 400, { error: 'webhookUrl must be an http(s) URL' })
      return
    }
    const taskId = brandString<SessionId>(`session-${randomUUID()}`)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    // The default-model creation idiom is deliberately identical to
    // dsh-headless's driver; extracting it would widen the core surface for
    // one shared ten-line stanza.
    /* jscpd:ignore-start */
    const { agent } = await this.ctx.agents.create({
      sessionId: taskId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    /* jscpd:ignore-end */
    await agent.whenIdle()
    const record: TaskRecord = {
      taskId,
      agent,
      firstSeq: agent.session.seq,
      webhookUrl,
      status: 'running',
      result: undefined,
    }
    this.tasks.set(String(taskId), record)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: body.task }],
      source: { kind: 'user' },
    }))
    json(res, 202, { taskId: String(taskId), status: 'queued' })
  }

  /** Answer one result query from the derived task status. */
  private status(record: TaskRecord, res: ServerResponse): void {
    if (record.status === 'running') {
      json(res, 200, { taskId: String(record.taskId), status: 'running' })
      return
    }
    json(res, 200, {
      taskId: String(record.taskId),
      status: 'finished',
      result: { text: record.result?.text ?? '', reason: record.result?.reason },
    })
  }

  /** Request cancellation; the resulting `turn/end` completes the task normally. */
  private cancel(record: TaskRecord, res: ServerResponse): void {
    if (record.status === 'finished') {
      json(res, 409, { error: 'task already finished' })
      return
    }
    record.agent.cancel({ kind: 'user' })
    json(res, 202, { taskId: String(record.taskId), status: 'cancelling' })
  }

  /** Stream the task's session events as SSE until the terminating `turn/end`. */
  private async streamEvents(record: TaskRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const queue: SessionEvent[] = []
    let resolvers = Promise.withResolvers<void>()
    const wake = (): void => { resolvers.resolve() }
    const dispose = this.ctx.on('session/event', (session, event) => {
      if (session.id !== record.taskId) return
      queue.push(event)
      wake()
    })
    req.on('close', () => { dispose(); wake() })
    let lastSent = record.firstSeq - 1
    try {
      const send = (event: SessionEvent): void => {
        if (event.seq <= lastSent || res.writableEnded || res.destroyed) return
        lastSent = event.seq
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      // Backfill first, then drain the subscription queue; seq dedupe closes
      // the gap between subscribing and snapshotting.
      for (const event of record.agent.session.ownEvents()) {
        if (event.seq >= record.firstSeq) send(event)
      }
      while (!res.writableEnded && !res.destroyed) {
        while (queue.length > 0) send(queue.shift() as SessionEvent)
        if (record.status === 'finished') break
        const current = resolvers
        await current.promise
        // Swap only after the awaited promise settles, so wake() always
        // resolves the resolver this loop is awaiting, never a fresh one.
        resolvers = Promise.withResolvers<void>()
      }
    } finally {
      dispose()
    }
    if (!res.writableEnded && !res.destroyed) res.end()
  }

  /** Derive the final outcome from the session log, publish it, and deliver the webhook. */
  private finish(record: TaskRecord, end: SessionEvent<'turn/end'>): void {
    let text = ''
    for (const event of record.agent.session.ownEvents()) {
      if (event.seq < record.firstSeq || event.type !== 'assistant/message') continue
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    record.status = 'finished'
    record.result = { text, reason: end.data.reason }
    if (record.webhookUrl !== undefined) this.deliverWebhook(record)
  }

  /** POST the final outcome once per configured attempt; failures only log. */
  private deliverWebhook(record: TaskRecord): void {
    const url = record.webhookUrl
    if (url === undefined) return
    const body = JSON.stringify({
      taskId: String(record.taskId),
      status: 'finished',
      result: { text: record.result?.text ?? '', reason: record.result?.reason },
    })
    void (async () => {
      for (let attempt = 0; attempt <= this.webhook.retries; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(this.webhook.timeoutMs),
          })
          if (response.ok) return
          this.ctx.logger.warn(new Error(`task-service: webhook answered HTTP ${response.status} (attempt ${attempt})`))
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })()
  }

  /**
   * Whether one session id has a registered task. Read by the package
   * invariant companion to scope its agent-liveness check.
   * @param taskId - session id in wire form.
   * @returns whether a task record exists for the id.
   */
  hasTask(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  /**
   * Task ids whose record no longer holds the agent registry's live agent.
   * Read by the package invariant companion; an empty result is the healthy one.
   * @returns the stale task ids in registration order.
   */
  staleTaskIds(): readonly string[] {
    return [...this.tasks.entries()]
      .filter(([, record]) => this.ctx.agents.get(record.agent.id) !== record.agent)
      .map(([taskId]) => taskId)
  }
}

/** Whether one Authorization header presents exactly the expected bearer token. */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const prefix = 'Bearer '
  if (header === undefined || !header.startsWith(prefix)) return false
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(header.slice(prefix.length)), digest(expected))
}

/** Whether one value parses as an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Read and parse one bounded JSON request body. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const piece = chunk as Buffer
    total += piece.length
    if (total > maxBytes) throw new Error(`request body exceeds ${String(maxBytes)} bytes`)
    chunks.push(piece)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export default TaskService
