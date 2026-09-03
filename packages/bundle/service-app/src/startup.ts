/**
 * The service app's command-line provider: it parses the `dsh --profile service`
 * flag family (`--host`, `--port`) and its `--help` text, resolves each value
 * against the deployment environment (`DSH_SERVICE_HOST`, `DSH_SERVICE_PORT`)
 * with the invocation flag first, and provides the resolved pair as
 * {@link SERVICE_STARTUP_SERVICE}. Unlike the Web provider, which publishes
 * only the flags the invocation named, this provider owns the whole
 * host-and-port resolution so an invalid environment value fails at parse time
 * instead of being silently coerced inside the bundle patch.
 * @module @deepseek-ai/dsh-service-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { internals, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'service-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by the webserver row. */
export const SERVICE_STARTUP_SERVICE = 'serviceStartup'

/** The two bind hosts the webserver schema supports. */
export type ServiceHost = '127.0.0.1' | '0.0.0.0'

/** What the webserver row reads from {@link SERVICE_STARTUP_SERVICE}. */
export interface ServiceStartupValues {
  /** Bind host: `--host`, else `DSH_SERVICE_HOST`, else loopback. */
  host: ServiceHost
  /** Listen port: `--port`, else `DSH_SERVICE_PORT`, else OS-assigned. */
  port: number
}

/** The service flag family, as commander parsed it. */
interface ServiceOptions {
  host?: string
  port?: string
}

/** Environment name carrying the deployment-default bind host. */
const ENV_HOST = 'DSH_SERVICE_HOST'
/** Environment name carrying the deployment-default listen port. */
const ENV_PORT = 'DSH_SERVICE_PORT'
/** Bind-host literal that exposes every network interface. */
const ALL_INTERFACES_HOST = '0.0.0.0'
/** Default bind host when neither the flag nor the environment names one. */
const DEFAULT_HOST = '127.0.0.1'
/** Default listen port when neither the flag nor the environment names one. */
const DEFAULT_PORT = 0

function isServiceHost(value: string): value is ServiceHost {
  return value === '127.0.0.1' || value === ALL_INTERFACES_HOST
}

/**
 * Warn before an all-interfaces bind: the bearer token travels over plaintext
 * HTTP, so a public deployment needs a TLS-terminating reverse proxy in front.
 */
function warnPublicBind(): void {
  internals.stderr.write(`dsh service: --host ${ALL_INTERFACES_HOST} exposes the task service to the network; the bearer token travels over plaintext HTTP and can be sniffed — front public deployments with a TLS-terminating reverse proxy\n`)
}

/**
 * Validate one bind-host candidate, failing the command line on anything
 * outside the two supported literals.
 * @param program - the program whose usage error exits the process.
 * @param source - the flag or environment name naming the rejected value.
 * @param value - the candidate bind host.
 * @returns the validated bind host.
 */
function serviceHost(program: Command, source: string, value: string): ServiceHost {
  if (!isServiceHost(value)) {
    program.error(`error: ${source} must be ${DEFAULT_HOST} or ${ALL_INTERFACES_HOST}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate one port candidate, failing the command line on a non-numeric value.
 * @param program - the program whose usage error exits the process.
 * @param source - the flag or environment name naming the rejected value.
 * @param value - the candidate port.
 * @returns the validated port number.
 */
function servicePort(program: Command, source: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    program.error(`error: ${source} must be a number, got ${JSON.stringify(value)}`)
  }
  return Number(value)
}

/**
 * Parse and provide the resolved service listen values as an ordinary Cordis
 * service. The command's action publishes the resolved pair; an invalid flag
 * or environment value is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile service')
    .description('Serve the DeepSeek Harness remote task service.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', `bind host (${DEFAULT_HOST} or ${ALL_INTERFACES_HOST})`)
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .addHelpText('after', `
Examples:
  dsh --profile service                          listen on loopback with an OS-assigned port
  dsh --profile service --host 0.0.0.0 --port 18923   listen on all interfaces
`)
  program.action(() => {
    const options = program.opts<ServiceOptions>()
    // An empty environment value reads as unset — `DSH_SERVICE_PORT=` from a
    // shell or service file clears the deployment default rather than naming
    // a port. The invocation flag replaces the environment value entirely, so
    // an invalid environment value under a valid flag is never read.
    const envHost = process.env[ENV_HOST] || undefined
    const host = options.host !== undefined
      ? serviceHost(program, '--host', options.host)
      : envHost !== undefined ? serviceHost(program, ENV_HOST, envHost) : DEFAULT_HOST
    const envPort = process.env[ENV_PORT] || undefined
    const port = options.port !== undefined
      ? servicePort(program, '--port', options.port)
      : envPort !== undefined ? servicePort(program, ENV_PORT, envPort) : DEFAULT_PORT
    if (host === ALL_INTERFACES_HOST) warnPublicBind()
    ctx.provide(SERVICE_STARTUP_SERVICE, { host, port } satisfies ServiceStartupValues)
  })
  parseCmdline(ctx, program)
}
