/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--no-open`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { internals, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: '127.0.0.1' | '0.0.0.0'
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
}

/** Bind-host literal that exposes every network interface. */
const ALL_INTERFACES_HOST = '0.0.0.0'
/** The webserver schema's two supported bind hosts. */
const SUPPORTED_HOSTS = ['127.0.0.1', ALL_INTERFACES_HOST] as const

function isBindHost(value: string): value is '127.0.0.1' | '0.0.0.0' {
  return (SUPPORTED_HOSTS as readonly string[]).includes(value)
}

/**
 * Validate one `--host` value against the two supported literals, failing the
 * command line on anything else.
 * @param program - the program whose usage error exits the process.
 * @param value - the candidate bind host.
 * @returns the validated bind host.
 */
function bindHost(program: Command, value: string): '127.0.0.1' | '0.0.0.0' {
  if (!isBindHost(value)) {
    program.error(`error: --host must be ${SUPPORTED_HOSTS[0]} or ${SUPPORTED_HOSTS[1]}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Warn before an all-interfaces bind: the process token and session cookie
 * travel over plaintext HTTP, and a public authority must still be named with
 * `--trusted-host` before the `/api` fence accepts it.
 */
function warnPublicBind(): void {
  internals.stderr.write(`dsh web: --host ${ALL_INTERFACES_HOST} exposes the GUI to the network; the process token and session cookie travel over plaintext HTTP and can be sniffed — front public deployments with a TLS-terminating reverse proxy, and name the public authority with --trusted-host\n`)
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (127.0.0.1 or 0.0.0.0)')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a `--host` outside
 * the two supported literals or a non-numeric `--port` is a usage error, so on
 * rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    const host = options.host === undefined ? undefined : bindHost(program, options.host)
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    if (host === ALL_INTERFACES_HOST) warnPublicBind()
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...host !== undefined && { host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
