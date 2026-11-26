/**
 * Layered undo probes (docs/DEVELOPMENT-GUIDE.zh.md §6.3).
 *
 * Rewinding A then B used to leave only B undoable: `beginRestore` retired A's
 * journal, and the undo endpoint refused any entry that was not the chain tail.
 * A layered undo has to do two things instead:
 *
 *   1. cascade — roll the NEWER rewinds' files back first, because their
 *      journals describe the states the target undo must pass through;
 *   2. cut — remove whatever dialogue a newer undo already republished, so the
 *      target's own replay does not publish the same text twice.
 *
 * These probes drive the real endpoint over a real temporary store, plus a
 * focused probe of the log surgery `cutReplayedTurn` performs.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore, createRewindRpcHandler, cutReplayedTurn, replayDialog } from '../src/index.ts'
import type { ReplaySpans } from '../src/index.ts'
import type { HistoryEntry } from '../src/history.ts'

let root: string
let store: SnapshotStore
const sessionId = 'session-cascade'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-cascade-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(name: string, content: string): Promise<string> {
  const abs = join(root, 'ws', name)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

/** One ledger row, undoable at the time it was written. */
function entry(opId: string, at: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    opId,
    workspaceKey: 'ws-1',
    sessionId,
    at,
    targetSeq: at,
    hadFiles: true,
    outcome: 'success',
    shadowedEvents: 1,
    messagePreview: opId,
    attachments: 0,
    undoable: true,
    ...overrides,
  }
}

/** A fake agent that can host a replay (the dialogue half reads `phase`). */
function fakeAgent(session: Session) {
  const agent = {
    session,
    phase: { kind: 'idle' as const, lastTurn: 0 },
    setPhase(next: { kind: 'idle'; lastTurn: number }) { agent.phase = next as never },
  }
  return agent
}

/** An in-memory ledger the endpoint can patch, standing in for `HistoryStore`. */
function ledgerHost(rows: HistoryEntry[]) {
  return {
    store: {
      list: async () => rows,
      patch: async (_key: string, opId: string, patch: Partial<HistoryEntry>) => {
        const index = rows.findIndex(row => row.opId === opId)
        if (index === -1) throw new Error(`unknown entry ${opId}`)
        rows[index] = { ...rows[index]!, ...patch }
      },
    },
    preview: false,
    archiveRoot: '',
    enabled: () => true,
  }
}

describe('undoing an older rewind cascades the newer ones back', () => {
  it('rolls the newer journal back first and stamps it as cascaded', async () => {
    // A self-consistent chain over ONE file:
    //   op-1: before v0, rewind goes v1 -> v0   (Y1 = v0)
    //   op-2: before v0b, rewind goes v0 -> v0b (Y2 = v0b, rewind前 = Y1)
    // Undoing op-1 without undoing op-2 first must pass through op-2's state,
    // so the target's stale check sees exactly Y1.
    const file = await touch('a.txt', 'v0')
    await store.recordEntry(sessionId, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(sessionId, 5, unlink, undefined, { opId: 'op-1' })
    expect(await readFile(file, 'utf8')).toBe('v0')

    await store.recordEntry(sessionId, { callId: 'c2', anchorSeq: 8, path: file, before: 'v0b' })
    await store.restoreAfter(sessionId, 8, unlink, undefined, { opId: 'op-2' })
    expect(await readFile(file, 'utf8')).toBe('v0b')

    const rows = [entry('op-1', 1), entry('op-2', 2)]
    const session = Session.create(SessionId(sessionId))
    const handler = createRewindRpcHandler(
      store,
      () => ({ get: () => fakeAgent(session) }) as never,
      () => true,
      () => ledgerHost(rows) as never,
      () => ({ key: 'ws-1' }) as never,
      () => new Set<string>(),
    )

    const result = await handler('undo', { sessionId, opId: 'op-1' }, new AbortController().signal, undefined) as {
      ok: boolean
      error?: { code: string; message: string }
      value?: { kind: string; cascaded: number; failed: unknown[] }
    }
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ cascaded: 1, kind: 'ok' })
    // op-2 described the intermediate state, so it is consumed by the cascade.
    expect(rows.find(row => row.opId === 'op-2')).toMatchObject({
      undoneAt: expect.any(Number),
      undoMode: 'files',
      cascadedBy: 'op-1',
    })
    expect(rows.find(row => row.opId === 'op-1')?.undoneAt).toBeTypeOf('number')
    // Files end at op-1's pre-rewind state (v1): the cascade restored Y1 first,
    // then op-1's own rescue copy went back over it.
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('stops before the target when a cascaded file was edited afterwards', async () => {
    const file = await touch('b.txt', 'v0')
    await store.recordEntry(sessionId, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(sessionId, 5, unlink, undefined, { opId: 'op-1' })

    const second = await touch('b.txt', 'v0b')
    await store.recordEntry(sessionId, { callId: 'c2', anchorSeq: 8, path: second, before: 'v0b' })
    await store.restoreAfter(sessionId, 8, unlink, undefined, { opId: 'op-2' })
    // The user edits after the newer rewind: its undo must refuse, and the
    // target undo must not restore over it.
    await writeFile(second, 'v3', 'utf8')

    const rows = [entry('op-1', 1), entry('op-2', 2)]
    const session = Session.create(SessionId(sessionId))
    const handler = createRewindRpcHandler(
      store,
      () => ({ get: () => ({ session }) }) as never,
      () => true,
      () => ledgerHost(rows) as never,
      () => ({ key: 'ws-1' }) as never,
      () => new Set<string>(),
    )

    const result = await handler('undo', { sessionId, opId: 'op-1' }, new AbortController().signal, undefined) as {
      ok: boolean
      value?: { kind: string; cascaded: number; failed: { path: string; message: string }[] }
    }
    expect(result.ok).toBe(true)
    expect(result.value?.kind).toBe('partial')
    expect(result.value?.cascaded).toBe(0)
    expect(result.value?.failed.some(item => item.path === '<cascade op-2>')).toBe(true)
    // Neither entry is consumed: the cascade can be retried.
    expect(rows.every(row => row.undoneAt === undefined)).toBe(true)
    expect(await readFile(second, 'utf8')).toBe('v3')
  })
})

describe('undoing an older rewind cuts the newer undo\'s replay back out', () => {
  const dialogA = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'A one question' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'A one answer' }] },
  ]
  const dialogB = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'B two question' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'B two answer' }] },
  ]

  function surfaceDump(session: Session): string {
    const events = session.snapshotEvents()
    return session.surface.nodes
      .map(seq => JSON.stringify(events.find(item => item.seq === seq)?.data))
      .join('\n')
  }

  it('removes the earlier replay instead of publishing the same text twice', async () => {
    const file = await touch('c.txt', 'v0')
    await store.recordEntry(sessionId, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(sessionId, 5, unlink, undefined, { opId: 'op-1', dialog: dialogA })

    await store.recordEntry(sessionId, { callId: 'c2', anchorSeq: 8, path: file, before: 'v0b' })
    await store.restoreAfter(sessionId, 8, unlink, undefined, { opId: 'op-2', dialog: dialogB })

    const rows = [entry('op-1', 1), entry('op-2', 2)]
    const session = Session.create(SessionId(sessionId))
    const handler = createRewindRpcHandler(
      store,
      () => ({ get: () => fakeAgent(session) }) as never,
      () => true,
      () => ledgerHost(rows) as never,
      () => ({ key: 'ws-1' }) as never,
      () => new Set<string>(),
    )

    // Undo the NEWER rewind first: its dialogue is republished as a new turn.
    const undoSelf = await handler('undo', { sessionId, opId: 'op-2' }, new AbortController().signal, undefined) as {
      ok: boolean
      error?: unknown
      value?: { replayed: number }
    }
    expect(undoSelf.error, JSON.stringify(undoSelf)).toBeUndefined()
    expect(undoSelf.value?.replayed).toBe(2)
    expect(surfaceDump(session)).toContain('B two question')
    expect(rows.find(row => row.opId === 'op-2')?.replayedSurfaceSeqs?.length).toBeGreaterThan(0)

    // Undo the OLDER rewind: the newer replay has to be cut back out first,
    // otherwise 'B two question' would be on the surface twice (once from the
    // replay, once from op-1's own replay of the withdrawn dialogue).
    const undoOlder = await handler('undo', { sessionId, opId: 'op-1' }, new AbortController().signal, undefined) as {
      ok: boolean
      error?: unknown
      value?: { replayed: number; cascaded: number }
    }
    expect(undoOlder.error, JSON.stringify(undoOlder)).toBeUndefined()
    expect(undoOlder.value).toMatchObject({ replayed: 2, cascaded: 0 })
    const dump = surfaceDump(session)
    expect(dump).toContain('A one question')
    // Undoing op-1 says the later rewinds never happened, so the turn op-2's
    // undo published is withdrawn with them: the B text is gone, not doubled.
    expect(dump).not.toContain('B two question')
    expect(rows.find(row => row.opId === 'op-2')?.replayCutAt).toBeTypeOf('number')
    expect(() => Session.create(session.id, session.snapshotEvents())).not.toThrow()
  })
})

describe('cutReplayedTurn removes a previous undo\'s replay from the surface', () => {
  /** Long enough text that a cut and a replay are distinguishable in the dump. */
  const dialog = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'cascade question one' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'cascade answer one' }] },
  ]

  /**
   * Everything currently visible, as one string: JSON of each surface node's
   * event data. Shape-agnostic on purpose — the probe only cares whether a
   * given sentence is on the surface.
   */
  function surfaceText(session: Session): string {
    const events = session.snapshotEvents()
    return session.surface.nodes
      .map(seq => {
        const event = events.find(item => item.seq === seq)
        return event === undefined ? '' : JSON.stringify(event.data)
      })
      .join('\n')
  }

  it('cuts exactly the replayed events and keeps the log replayable', () => {
    const session = Session.create(SessionId('cascade-cut'))
    const spans: ReplaySpans = { surfaceSeqs: [] }
    expect(replayDialog(session, dialog, undefined, spans)).toBe(2)
    expect(spans.surfaceSeqs.length).toBeGreaterThan(0)
    expect(surfaceText(session)).toContain('cascade question one')

    expect(cutReplayedTurn(session, spans)).toBe(true)
    expect(surfaceText(session)).not.toContain('cascade question one')
    expect(surfaceText(session)).not.toContain('cascade answer one')

    // The cut is a `replace` marker over an earlier span: the log must still
    // replay (a marker whose sources omit a shadowed node fails to load).
    expect(() => Session.create(session.id, session.snapshotEvents())).not.toThrow()
  })

  it('reports false when every span seq is already shadowed', () => {
    const session = Session.create(SessionId('cascade-cut-idempotent'))
    const spans: ReplaySpans = { surfaceSeqs: [] }
    replayDialog(session, dialog, undefined, spans)

    expect(cutReplayedTurn(session, spans)).toBe(true)
    // Second call: the seqs are off the surface, so there is nothing to cite.
    expect(cutReplayedTurn(session, { ...spans, surfaceSeqs: [...spans.surfaceSeqs] as SessionSeq[] })).toBe(false)
  })
})
