/**
 * History-store probes: partitioning, the per-partition cap, crash-safe writes,
 * corrupt-file recovery, and the rewind-chain helpers the undo path relies on.
 *
 * The store is fs-only by design, so every probe uses a real temporary
 * directory (no fs mock): the atomic-write and recovery behaviour is the thing
 * under test.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cwdKey,
  errorText,
  HistoryStore,
  newOpId,
  previewText,
  safeKeySegment,
  unknownKey,
  workspaceIdOf,
  workspaceKeyFromRegistry,
  type HistoryEntry,
} from '../src/history.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-history-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One synthetic entry. */
function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  const at = overrides.at ?? 1_700_000_000_000
  return {
    opId: overrides.opId ?? newOpId(at),
    workspaceKey: overrides.workspaceKey ?? 'ws-w1',
    sessionId: overrides.sessionId ?? 's1',
    at,
    targetSeq: 5,
    hadFiles: true,
    outcome: 'success',
    shadowedEvents: 3,
    messagePreview: 'hello',
    attachments: 0,
    undoable: true,
    ...overrides,
  }
}

describe('key helpers', () => {
  it('keeps [a-zA-Z0-9._-] and refuses a bare dot path', () => {
    expect(safeKeySegment('ws-abc_1.2')).toBe('ws-abc_1.2')
    expect(safeKeySegment('a/b:c')).toBe('a_b_c')
    expect(safeKeySegment('..')).toBe('_')
    expect(safeKeySegment('')).toBe('_')
  })

  it('resolves a session through the workspace registry by reverse lookup', () => {
    const workspaces = [
      { workspaceId: 'w1', path: 'D:/a', sessionIds: ['s2'] },
      { workspaceId: 'w2', path: 'D:/b', sessionIds: ['s1', 's3'] },
    ]
    expect(workspaceKeyFromRegistry('s1', workspaces)).toEqual({
      key: 'ws-w2',
      workspace: workspaces[1],
    })
    expect(workspaceKeyFromRegistry('s9', workspaces)).toBeUndefined()
    expect(workspaceKeyFromRegistry('s1', undefined)).toBeUndefined()
  })

  it('reads the `id` field the registry entity actually serves', () => {
    // `workspaceRegistry.list()` returns `Workspace` ENTITIES (field `id`),
    // not the RPC `WorkspaceView` (field `workspaceId`). Reading only
    // `workspaceId` produced `undefined.replace(...)` and failed the rewind.
    const workspaces = [
      { id: 'w1', path: 'D:/a', sessionIds: ['s2'] },
      { id: 'w2', path: 'D:/b', sessionIds: ['s1'] },
    ]
    expect(workspaceKeyFromRegistry('s1', workspaces)).toEqual({
      key: 'ws-w2',
      workspace: workspaces[1],
    })
  })

  it('falls back to the unknown partition instead of crashing on a missing id', () => {
    const workspaces = [{ path: 'D:/a', sessionIds: ['s1'] }]
    expect(workspaceIdOf(workspaces[0]!)).toBeUndefined()
    // The pre-fix path threw here: safeKeySegment(undefined) → undefined.replace
    expect(workspaceKeyFromRegistry('s1', workspaces)).toBeUndefined()
    expect(safeKeySegment(undefined)).toBe('_')
  })

  it('hashes a canonical directory into a stable 12-char key', () => {
    const a = cwdKey('D:/work/a')
    expect(a).toBe(cwdKey('D:/work/a'))
    expect(a).toMatch(/^cwd-[0-9a-f]{12}$/)
    expect(a).not.toBe(cwdKey('D:/work/b'))
    expect(unknownKey()).toBe('_unknown')
  })

  it('collapses and caps the stored preview; disabled stores nothing', () => {
    expect(previewText('a\n\nb   c', true)).toBe('a b c')
    const long = 'x'.repeat(200)
    expect(previewText(long, true)).toHaveLength(80)
    expect(previewText('secret', false)).toBe('')
    expect(errorText('y'.repeat(400))).toHaveLength(200)
  })
})

describe('HistoryStore partitioning and the cap', () => {
  it('round-trips one entry', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    await store.append(entry())
    const list = await store.list('ws-w1')
    expect(list).toHaveLength(1)
    expect(list[0]!.targetSeq).toBe(5)
  })

  it('isolates partitions from each other', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    await store.append(entry({ workspaceKey: 'ws-w1' }))
    await store.append(entry({ workspaceKey: 'ws-w2', at: 1_700_000_000_001 }))
    expect(await store.list('ws-w1')).toHaveLength(1)
    expect(await store.list('ws-w2')).toHaveLength(1)
  })

  it('keeps only the newest `limit` entries, per partition', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    for (let index = 0; index < 12; index += 1) {
      await store.append(entry({ at: 1_700_000_000_000 + index, targetSeq: index }))
    }
    const list = await store.list('ws-w1')
    expect(list).toHaveLength(10)
    // The two oldest went away; the newest is last.
    expect(list[0]!.targetSeq).toBe(2)
    expect(list[9]!.targetSeq).toBe(11)
  })

  it('serializes concurrent appends so none are lost', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.append(entry({ at: 1_700_000_000_000 + index, targetSeq: index }))),
    )
    const list = await store.list('ws-w1')
    expect(list).toHaveLength(10)
  })

  it('clears one partition and reports the count', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    await store.append(entry())
    await store.append(entry({ at: 1_700_000_000_001 }))
    await expect(store.clear('ws-w1')).resolves.toBe(2)
    expect(await store.list('ws-w1')).toHaveLength(0)
  })
})

describe('HistoryStore durability', () => {
  it('moves a corrupt partition aside instead of deleting it', async () => {
    const dir = await root()
    const store = new HistoryStore({ root: dir, limit: 10, preview: true })
    const file = store.partitionPath('ws-w1')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'ws-w1'), { recursive: true })
    await writeFile(file, '{not json', 'utf8')
    const list = await store.list('ws-w1')
    expect(list).toHaveLength(0)
    const names = await readdir(join(dir, 'ws-w1'))
    expect(names.some(name => name.includes('.corrupt-'))).toBe(true)
  })

  it('rejects an unknown file version the same way', async () => {
    const dir = await root()
    const store = new HistoryStore({ root: dir, limit: 10, preview: true })
    const file = store.partitionPath('ws-w1')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'ws-w1'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 99, workspace: { key: 'ws-w1' }, entries: [] }), 'utf8')
    expect(await store.list('ws-w1')).toHaveLength(0)
    const names = await readdir(join(dir, 'ws-w1'))
    expect(names.some(name => name.includes('.corrupt-'))).toBe(true)
  })

  it('writes atomically (no tmp file left behind)', async () => {
    const dir = await root()
    const store = new HistoryStore({ root: dir, limit: 10, preview: true })
    await store.append(entry())
    const names = await readdir(join(dir, 'ws-w1'))
    expect(names).toEqual(['history.json'])
    const body = JSON.parse(await readFile(join(dir, 'ws-w1', 'history.json'), 'utf8')) as { entries: unknown[] }
    expect(body.entries).toHaveLength(1)
  })

  it('never rejects on a write failure (history must not fail the rewind)', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    // A directory where the file should go makes rename fail.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(store.partitionPath('ws-w1'), { recursive: true })
    await expect(store.append(entry())).resolves.toBe(false)
  })
})

describe('rewind-chain helpers', () => {
  it('treats the newest non-undone entry of a session as the tail', () => {
    const older = entry({ opId: 'a', at: 1 })
    const newer = entry({ opId: 'b', at: 2 })
    const other = entry({ opId: 'c', at: 3, sessionId: 's2' })
    const entries = [older, newer, other]
    expect(HistoryStore.chainTail(entries, 's1')?.opId).toBe('b')
    expect(HistoryStore.isChainTail(entries, newer)).toBe(true)
    expect(HistoryStore.isChainTail(entries, older)).toBe(false)
    expect(HistoryStore.previousOf(entries, 's1')).toBe('b')
  })

  it('skips undone entries when finding the tail', () => {
    const older = entry({ opId: 'a', at: 1 })
    const newer = entry({ opId: 'b', at: 2, undoneAt: 3 })
    expect(HistoryStore.chainTail([older, newer], 's1')?.opId).toBe('a')
  })

  it('patches one entry once (the undo lock)', async () => {
    const store = new HistoryStore({ root: await root(), limit: 10, preview: true })
    const target = entry({ opId: 'op-1' })
    await store.append(target)
    await expect(store.patch('ws-w1', 'op-1', { undoneAt: 123, undoOutcome: 'success' })).resolves.toBe(true)
    const list = await store.list('ws-w1')
    expect(list[0]!.undoneAt).toBe(123)
    expect(list[0]!.undoOutcome).toBe('success')
    // A vanished entry reports false instead of creating one.
    await expect(store.patch('ws-w1', 'op-missing', { undoneAt: 1 })).resolves.toBe(false)
  })
})
