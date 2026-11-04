/**
 * Host-RPC registration probes.
 *
 * The rewind RPC channel lives on the Host Connection service, and `rpc.handle`
 * stores its route through `owner.effect(() => owner.webServer.register(route))`
 * where `owner` is the CONNECTION service's own define-site context. When
 * `webServer` and `connection` are provided by two different plugin fibres — the
 * layout the harness always has — that lookup walks the provider's fibre chain,
 * dead-ends at the root fibre (`runtime === null`) and throws
 * `cannot get property "webServer" without inject`. The channel then never
 * exists, and every client query degrades to "host RPC is unavailable"
 * (Settings → Rewind history shows exactly that).
 *
 * These probes pin both halves: the bare registration fails on this harness
 * line, and `rebaseOnRoot` (the shipped fix) registers through.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { rebaseOnRoot, rawServiceOf } from '../src/index.ts'

/** Stand-in for the harness `webServer` service: records the routes it mounts. */
class FakeWebServer extends Service {
  /** Mounted route paths, in registration order. */
  public readonly routes: string[] = []
  constructor(ctx: Context) { super(ctx, 'webServer') }
  register(route: { readonly path: string }): () => void {
    this.routes.push(route.path)
    return () => { this.routes.splice(this.routes.indexOf(route.path), 1) }
  }
}

/**
 * Stand-in for the harness `connection` service, reproducing the exact shape the
 * real one has: constructor state on the instance, and `rpc.handle` taking its
 * owner from `this.ctx` then reading `owner.webServer` inside an effect.
 */
class FakeConnection extends Service {
  /** Constructor state the re-based wrapper must still expose. */
  public readonly token = 'instance-token'
  constructor(ctx: Context) { super(ctx, 'connection') }
  get rpc(): { handle(channel: string, handler: () => unknown): () => Promise<void> } {
    const owner = this.ctx
    return { handle: (channel: string) => this.register(owner, channel) }
  }
  register(owner: Context, channel: string): () => Promise<void> {
    const server = (owner as unknown as { readonly webServer: FakeWebServer }).webServer
    return owner.effect(() => server.register({ path: channel }), `rpc channel ${channel}`)
  }
}

/** Mount webServer and connection in separate fibres, as the harness does, and return the root. */
function harness(): { readonly root: Context } {
  const root = new Context()
  root.plugin({ name: 'fake-webserver', apply(ctx) { new FakeWebServer(ctx) } })
  root.plugin({ name: 'fake-connection', apply(ctx) { new FakeConnection(ctx) } })
  return { root }
}

/** The mounted webServer instance, read after the injected scopes settle. */
function webServerOf(root: Context): FakeWebServer {
  return root.get('webServer') as FakeWebServer
}

/** Wait for the injected scopes to settle (cordis runs them off the tick). */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50))
}

describe('host RPC channel registration', () => {
  it('fails through the bare service when webServer lives in another fibre', async () => {
    const { root } = harness()
    const errors: string[] = []
    root.plugin({
      name: 'probe-bare',
      apply(ctx) {
        ctx.inject(['connection'], (scope) => {
          try {
            (scope.get('connection') as unknown as FakeConnection).rpc.handle('/dsh-rewind', () => null)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        })
      },
    })
    await settle()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('without inject')
  })

  it('registers the channel through the root-rebased service', async () => {
    const { root } = harness()
    const errors: string[] = []
    let disposed = false
    let token = ''
    root.plugin({
      name: 'probe-rebased',
      apply(ctx) {
        ctx.inject(['connection'], (scope) => {
          try {
            const raw = rawServiceOf(scope, 'connection') as FakeConnection | undefined
            expect(raw).toBeDefined()
            const host = rebaseOnRoot(raw!, scope.root)
            expect(host).toBeDefined()
            // Constructor state must survive the re-base: the route handler runs
            // long after registration and reads instance fields.
            token = host!.token
            scope.effect(() => host!.rpc.handle('/dsh-rewind-rpc', () => null), 'probe channel')
            disposed = true
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        })
      },
    })
    await settle()
    expect(errors).toEqual([])
    expect(disposed).toBe(true)
    expect(token).toBe('instance-token')
    expect(webServerOf(root).routes).toContain('/dsh-rewind-rpc')
  })

  it('reads the raw instance out of a traced context', async () => {
    const { root } = harness()
    let raw: FakeConnection | undefined
    let proxied: FakeConnection | undefined
    root.plugin({
      name: 'probe-raw',
      apply(ctx) {
        ctx.inject(['connection'], (scope) => {
          proxied = scope.get('connection') as FakeConnection
          raw = rawServiceOf(scope, 'connection') as FakeConnection | undefined
        })
      },
    })
    await settle()
    // The context hands back a traced wrapper; the reflection store hands back the
    // implementation the constructor actually populated.
    expect(proxied).toBeDefined()
    expect(raw).toBeInstanceOf(FakeConnection)
    expect(raw!.token).toBe('instance-token')
  })

  it('returns undefined for a service the wrapper cannot be rebuilt from', () => {
    expect(rebaseOnRoot({} as object, {})).toBeUndefined()
    expect(rawServiceOf({}, 'connection')).toBeUndefined()
  })
})
