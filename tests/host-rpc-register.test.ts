/**
 * Host-RPC registration probes.
 *
 * The rewind RPC channel lives on the Host Connection service, and `rpc.handle`
 * stores its route through `owner.effect(() => owner.get('webServer').register(route))`
 * where `owner` is whichever context the CONNECTION service is read from. The
 * harness provides `webServer` and `connection` in two DIFFERENT plugin fibres, so
 * an owner that only resolved `connection` finds no WebServer and registration
 * throws — on cordis 4.0 as `cannot get property "webServer" without inject`, on
 * 4.2 as `connection: RPC channels require a WebServer`. The channel then never
 * exists and every client query degrades to "host RPC is unavailable" (Settings →
 * Rewind history shows exactly that, and the web client reports HTTP 405 because
 * the route was never mounted).
 *
 * These probes pin both halves: the single-service owner fails on the shape the
 * harness has, and `rebaseOnOwner` onto a scope that injects BOTH services
 * registers through.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { rebaseOnOwner, rawServiceOf } from '../src/index.ts'

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
 * real one has: constructor state on the instance, `rpc.handle` taking its owner
 * from `this.ctx`, and the owner resolving `webServer` THROUGH `get` inside an
 * effect (cordis 4.2's shape; 4.0 threw on the same read).
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
    return owner.effect(() => {
      const server = owner.get('webServer') as FakeWebServer | undefined
      if (server === undefined) throw new Error('connection: RPC channels require a WebServer')
      return server.register({ path: channel })
    }, `rpc channel ${channel}`)
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
  it('registers the channel when the owner declares webServer itself', async () => {
    const { root } = harness()
    const errors: string[] = []
    let disposed = false
    let token = ''
    let sawWebServer = false
    root.plugin({
      name: 'probe-rebased',
      apply(ctx) {
        ctx.inject(['connection', 'webServer'], (scope) => {
          try {
            sawWebServer = scope.get('webServer') !== undefined
            const raw = rawServiceOf(scope, 'connection') as FakeConnection | undefined
            expect(raw).toBeDefined()
            const host = rebaseOnOwner(raw!, scope)
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
    expect(sawWebServer).toBe(true)
    expect(token).toBe('instance-token')
    expect(webServerOf(root).routes).toContain('/dsh-rewind-rpc')
  })

  it('unmounts the route when the injected scope is disposed', async () => {
    const { root } = harness()
    let stop: (() => Promise<void>) | undefined
    const fiber = root.plugin({
      name: 'probe-dispose',
      apply(ctx) {
        ctx.inject(['connection', 'webServer'], (scope) => {
          const raw = rawServiceOf(scope, 'connection') as FakeConnection
          const host = rebaseOnOwner(raw, scope)!
          stop = host.rpc.handle('/dsh-rewind-dispose', () => null)
        })
      },
    })
    await settle()
    expect(webServerOf(root).routes).toContain('/dsh-rewind-dispose')
    await fiber.dispose()
    expect(webServerOf(root).routes).not.toContain('/dsh-rewind-dispose')
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
    expect(rebaseOnOwner({} as object, {})).toBeUndefined()
    expect(rawServiceOf({}, 'connection')).toBeUndefined()
  })
})
