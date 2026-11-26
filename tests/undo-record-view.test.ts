/**
 * The settings page must not offer an undo the host is going to refuse
 * (docs/DEVELOPMENT-GUIDE.zh.md §6.3: only the newest rewind is undoable).
 *
 * The history ledger stamps `undoable` when a rewind finishes and is never
 * rewritten afterwards, but `beginRestore` retires the previous `completed`
 * journal as soon as a newer rewind starts. A ledger row can therefore keep
 * promising an undo whose record is already gone — the user clicks it and gets
 * `rewind/undo-unavailable`. These probes pin the two halves of the fix: the
 * store can say which journals a session still has, and the history endpoint
 * re-derives the flag from that instead of trusting the ledger.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore, createRewindRpcHandler } from '../src/index.ts'
import type { HistoryEntry } from '../src/history.ts'

let root: string
let store: SnapshotStore
const session = 'session-undo-record'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-undo-record-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write one journal file into the given session directory. */
async function seedJournal(sessionId: string, name: string, state: string): Promise<void> {
  const dir = store.sessionDir(sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify({
    version: 2,
    id: 'irrelevant',
    sessionId,
    targetSeq: 1,
    startedAt: 1,
    state,
    actions: [],
  }), 'utf8')
}

describe('SnapshotStore.listUndoableOpIds', () => {
  it('names exactly the journals whose state is completed', async () => {
    await seedJournal(session, 'journal-op-a.json', 'completed')
    await seedJournal(session, 'journal-op-b.json', 'rolled-back')
    await seedJournal(session, 'journal-op-c.json', 'running')
    // Legacy prefix names a journal too: an old pending restore is still not
    // undoable, but a completed one under the legacy name is.
    await seedJournal(session, 'restore-journal-op-d.json', 'completed')

    expect(await store.listUndoableOpIds(session)).toEqual(new Set(['op-a', 'op-d']))
  })

  it('leaves out unreadable journals instead of guessing', async () => {
    const dir = store.sessionDir(session)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'journal-op-broken.json'), '{"version":2,"state":', 'utf8')

    expect(await store.listUndoableOpIds(session)).toEqual(new Set())
  })

  it('treats a session that never had a restore as having nothing to undo', async () => {
    expect(await store.listUndoableOpIds(session)).toEqual(new Set())
  })
})

/** Build the history endpoint's handler over a fixed ledger and store. */
function historyHandler(entries: readonly HistoryEntry[]): ReturnType<typeof createRewindRpcHandler> {
  const agent = { session: { id: session } }
  return createRewindRpcHandler(
    store,
    () => ({ get: () => agent }) as never,
    () => true,
    () => ({
      store: { list: async () => entries },
      preview: false,
      archiveRoot: '',
      enabled: () => true,
    }) as never,
    () => ({ key: 'ws-1' }) as never,
    () => new Set<string>(),
  )
}

/** One ledger row, newest last, undoable at the time it was written. */
function entry(opId: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    opId,
    workspaceKey: 'ws-1',
    sessionId: session,
    at: 1,
    targetSeq: 5,
    hadFiles: true,
    outcome: 'success',
    shadowedEvents: 2,
    messagePreview: 'target',
    attachments: 0,
    undoable: true,
    ...overrides,
  }
}

describe('the history endpoint re-derives `undoable` from the journals on disk', () => {
  it('marks a row whose journal a newer rewind retired, instead of offering the undo', async () => {
    // `op-old` was undidable when it finished; starting the newer rewind
    // retired its journal, so only `op-new` has one left.
    await seedJournal(session, 'journal-op-new.json', 'completed')
    const handler = historyHandler([entry('op-old'), entry('op-new')])

    const result = await handler('history', { sessionId: session }, new AbortController().signal, undefined)
    expect(result).toMatchObject({ ok: true })
    const entries = (result as { ok: true; value: { entries: { opId: string; undoable: boolean; undoRecordGone?: boolean }[] } })
      .value.entries
    const older = entries.find(row => row.opId === 'op-old')
    const newer = entries.find(row => row.opId === 'op-new')
    expect(older).toMatchObject({ undoable: false, undoRecordGone: true })
    expect(newer).toMatchObject({ undoable: true })
    expect(newer?.undoRecordGone).toBeUndefined()
  })

  it('leaves an already-undone row alone: it is not waiting for a journal', async () => {
    // An undone rewind has no journal by design (undoing consumes it), so
    // re-deriving would mislabel it as "record gone".
    const handler = historyHandler([entry('op-done', { undoneAt: 2 })])

    const result = await handler('history', { sessionId: session }, new AbortController().signal, undefined)
    const entries = (result as { ok: true; value: { entries: { opId: string; undoable: boolean; undoRecordGone?: boolean }[] } })
      .value.entries
    expect(entries[0]).toMatchObject({ opId: 'op-done', undoable: true })
    expect(entries[0]?.undoRecordGone).toBeUndefined()
  })

  it('keeps an undoable row undoable while its journal is still there', async () => {
    await seedJournal(session, 'journal-op-live.json', 'completed')
    const handler = historyHandler([entry('op-live')])

    const result = await handler('history', { sessionId: session }, new AbortController().signal, undefined)
    const entries = (result as { ok: true; value: { entries: { opId: string; undoable: boolean; undoRecordGone?: boolean }[] } })
      .value.entries
    expect(entries[0]).toMatchObject({ opId: 'op-live', undoable: true })
    expect(entries[0]?.undoRecordGone).toBeUndefined()
  })
})
