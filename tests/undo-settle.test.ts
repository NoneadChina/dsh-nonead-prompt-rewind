/**
 * Regression probes for "undo a rewind, then the file stops being checkpointed".
 *
 * The reported sequence: edit a file → rewind once → restore to before that
 * rewind (the history page's undo). After the undo, later writes of that file
 * produced no before-backup at all, so the file was no longer part of the
 * rewind chain.
 *
 * Two independent halves keep a restored file tracked, and both are pinned here:
 *
 *  1. The store keeps the path recorded (`trackedPaths`) and still appends a new
 *     before-backup for it after the undo — the bytes side.
 *  2. The RPC `undo` handler runs the SAME settle step the rewind command runs:
 *     re-emitting the harness `fs/observed` truth for every restored/deleted
 *     path. Without it the session's next write of that file is judged against
 *     the pre-undo observation, fails as stale, and that failed call drops its
 *     before-capture — which is exactly how a file "leaves tracking".
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { HistoryEntry } from '../src/history.ts'
import { createRewindRpcHandler, syncRestoreObservations, type RewindSettle } from '../src/index.ts'
import { reconcileTracked, SnapshotStore, type RestoreOutcome } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-undo-settle-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(dir: string, name: string, content: string): Promise<string> {
  const abs = join(dir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

describe('undo keeps the file in the rewind chain (store)', () => {
  it('still records a before-backup after a rewind + undo round trip', async () => {
    const session = 'session-undo-tracking'
    const ws = join(root, 'ws')
    const file = await touch(ws, 'a.txt', 'v0')

    // Turn 5: the user edits the file — the capture records the BEFORE state.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')

    // Next message boundary (anchor 7): the re-check records v1 as the state the
    // boundary turn starts from.
    expect(await reconcileTracked(store, session, 7, await store.trackedPaths(session))).toBe(1)

    // Rewind to turn 5: the file goes back to v0.
    const rewind = await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-1' })
    expect(rewind.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v0')

    // History page: "restore to before this rewind".
    const undone = await store.undoRestore(session, 'op-1', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v1')

    // THE BUG: the path must still be tracked, so the boundary keeps snapshotting it.
    expect(await store.trackedPaths(session)).toContain(file)

    // A later edit captures v1 as ITS before-state, and that state is restorable.
    await store.recordEntry(session, { callId: 'c9', anchorSeq: 9, path: file, before: 'v1' })
    await writeFile(file, 'v2', 'utf8')
    const second = await store.restoreAfter(session, 9, unlink, undefined, { opId: 'op-2' })
    expect(second.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('re-creates a file the undo restored even when the rewind had deleted it', async () => {
    const session = 'session-undo-created'
    const ws = join(root, 'ws')
    const created = await touch(ws, 'new.txt', 'created-after-target')

    // The target predates the file: the rewind deletes it, the undo must bring it
    // back — and it must keep being tracked afterwards.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: created, before: null })
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-del' })
    await expect(readFile(created, 'utf8')).rejects.toThrow()

    const undone = await store.undoRestore(session, 'op-del', unlink)
    expect(undone.restored).toEqual([created])
    expect(await readFile(created, 'utf8')).toBe('created-after-target')
    expect(await store.trackedPaths(session)).toContain(created)
  })
})

describe('the RPC undo runs the same settle step as a rewind', () => {
  it('re-syncs the fs observation cache for every restored path', async () => {
    const emitted: unknown[][] = []
    const ctx = { emit: (...args: unknown[]) => emitted.push(args) } as unknown as Context
    const fs = {
      resolve: async (path: string) => ({ path }),
      stat: async () => ({ version: 'v2' }),
    } as unknown as FileSystem
    const outcome: RestoreOutcome = { restored: ['/ws/a.txt'], deleted: ['/ws/b.txt'], skipped: [], failed: [] }

    await syncRestoreObservations(ctx, fs, { session: { id: 's-1' } } as never, outcome)

    const kinds = emitted.map(args => (args[2] as { kind: string }).kind)
    expect(kinds).toEqual(['absent', 'present'])
  })

  it('invokes settle with the undo outcome before stamping the history entry', async () => {
    const session = { id: 's-1' } as unknown as Session
    const entry: HistoryEntry = {
      opId: 'op-1',
      workspaceKey: 'ws-1',
      sessionId: 's-1',
      at: 1,
      targetSeq: 5,
      hadFiles: true,
      outcome: 'success',
      shadowedEvents: 2,
      messagePreview: 'target',
      attachments: 0,
      undoable: true,
    }
    const patched: string[] = []
    const settled: RestoreOutcome[] = []
    const settle: RewindSettle = async (_agent, outcome) => {
      settled.push(outcome)
    }
    const handler = createRewindRpcHandler(
      {
        undoRestore: async () => ({ restored: ['/ws/a.txt'], deleted: [], skipped: [], failed: [] }),
      } as unknown as SnapshotStore,
      () => ({ get: () => ({ session }) }),
      () => true,
      () => ({
        store: {
          list: async () => [entry],
          patch: async (_key: string, opId: string) => { patched.push(opId) },
        },
        preview: false,
        archiveRoot: '',
        enabled: () => true,
      }) as never,
      () => ({ key: 'ws-1' }) as never,
      () => new Set<string>(),
      settle,
    )

    const result = await handler('undo', { sessionId: 's-1', opId: 'op-1' }, new AbortController().signal, undefined)
    expect(result).toMatchObject({ ok: true })
    expect(settled).toHaveLength(1)
    expect(settled[0]!.restored).toEqual(['/ws/a.txt'])
    expect(patched).toEqual(['op-1'])
  })
})
