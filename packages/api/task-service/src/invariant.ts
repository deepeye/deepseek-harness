/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-task-service`.
 * @module @deepseek-ai/dsh-task-service/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-service'

/** Cordis companion plugin name. */
export const name = 'task-service-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Every registered task must keep holding its registry's live agent. A record
 * whose agent was disposed or replaced outside the service would serve stale
 * results and accept cancellation for a dead driver, so the relation between
 * the task registry and the authoritative agent registry is checked on every
 * observed task turn boundary.
 */
const install: InvariantInstaller = (ctx, fail) => {
  const service = ctx.get('taskService') as
    | { hasTask(taskId: string): boolean; staleTaskIds(): readonly string[] }
    | undefined
  if (service === undefined) return // no task-service row in this composition
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (!service.hasTask(String(session.id))) return
    const stale = service.staleTaskIds()
    if (stale.length > 0) fail(`task(s) ${stale.map(id => JSON.stringify(id)).join(', ')} hold a disposed or replaced agent`)
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
