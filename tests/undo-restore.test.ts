/**
 * Undo probes for `SnapshotStore.undoRestore` (docs/DEVELOPMENT-GUIDE.zh.md §6.3).
 *
 * `rollbackRestore` only ever sees interrupted journals and refuses a
 * `completed` one, so the user-facing "restore to before this rewind" needs its
 * own entry point. These probes pin what that entry point owns against a REAL
 * temporary directory (no fs mock): the journal must be addressable by the
 * caller's op id, the pre-rewind bytes must come back, and a file edited after
 * the rewind must stop the whole undo instead of being overwritten.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-undo'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-undo-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write one workspace file (creating `ws/` on first use). */
async function touch(name: string, content: string): Promise<string> {
  const abs = join(root, 'ws', name)
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

describe('undoRestore', () => {
  it('addresses the journal by the caller op id and restores the post-rewind bytes', async () => {
    const file = await touch('a.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-test-1' })
    expect(outcome.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v0')

    // The journal lives under the CALLER's id, so a history entry can address it.
    const names = await readdir(store.sessionDir(session))
    expect(names.some(name => name.includes('op-test-1'))).toBe(true)

    const undone = await store.undoRestore(session, 'op-test-1', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('refuses the whole undo when a file changed after the rewind', async () => {
    const file = await touch('b.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-test-2' })
    expect(await readFile(file, 'utf8')).toBe('v0')

    // The user edits the file after the rewind: an undo would silently
    // overwrite that edit.
    await writeFile(file, 'v2', 'utf8')
    await expect(store.undoRestore(session, 'op-test-2', unlink)).rejects.toMatchObject({
      code: 'stale-undo',
    })
    expect(await readFile(file, 'utf8')).toBe('v2')
  })

  it('survives a budget prune of the sidecars it no longer needs', async () => {
    const file = await touch('d.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-test-prune' })

    // A later checkpoint installs a newer group; keep=1 then evicts the group
    // holding this rewind's `before` sidecar. The journal stays (undo record)
    // and the fingerprint makes the eviction harmless.
    const other = await touch('other.txt', 'x')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: other, before: 'x' })
    await store.prune(session, 1)
    await expect(readdir(join(store.sessionDir(session), '5'))).rejects.toThrow()

    const undone = await store.undoRestore(session, 'op-test-prune', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('re-creates a file the rewind had deleted', async () => {
    const file = await touch('c.txt', 'created-later')
    // The capture says the file did NOT exist at the anchor, so the rewind
    // deletes it and the undo must bring it back.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: null })
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-test-3' })
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    await store.undoRestore(session, 'op-test-3', unlink)
    expect(await readFile(file, 'utf8')).toBe('created-later')
  })

  it('refuses an id that has no journal', async () => {
    await expect(store.undoRestore(session, 'op-missing', unlink)).rejects.toThrow(/not found/u)
  })

  it('stays undoable when the PLAN failed for a path that was never applied', async () => {
    const restorable = await touch('ok.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: restorable, before: 'v0' })
    await writeFile(restorable, 'v1', 'utf8')

    // A second recorded path whose sidecar is gone: planning it FAILS (the file
    // itself is never touched), while the first path still restores.
    const broken = await touch('broken.txt', 'live')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: broken, before: 'recorded' })
    const sidecar = (await readdir(store.anchorDir(session, 6))).find(name => name.endsWith('.before'))
    if (sidecar === undefined) throw new Error('expected a staged sidecar')
    await rm(join(store.anchorDir(session, 6), sidecar), { force: true })

    const outcome = await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-plan-fail' })
    expect(outcome.restored).toEqual([restorable])
    expect(outcome.failed.map(f => f.path)).toEqual([broken])
    expect(await readFile(broken, 'utf8')).toBe('live')

    // The plan failure left `broken` alone, so every APPLIED action reached its
    // goal: the journal is completed and the rewind stays undoable.
    const undone = await store.undoRestore(session, 'op-plan-fail', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(restorable, 'utf8')).toBe('v1')
  })

  it('keeps the completed journal and its anchor group across a later commit prune', async () => {
    const file = await touch('keep.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-keep' })

    // A later write commits a newer anchor; the prune it runs must reclaim
    // neither the undo journal nor the `before` group its stale check reads.
    const other = await touch('other.txt', 'x')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: other, before: 'x' })
    await store.prune(session, 1)

    const undone = await store.undoRestore(session, 'op-keep', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('reports a consumed undo instead of a generic failure on the second call', async () => {
    const file = await touch('once.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v0' })
    await writeFile(file, 'v1', 'utf8')
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-once' })

    await store.undoRestore(session, 'op-once', unlink)
    await expect(store.undoRestore(session, 'op-once', unlink)).rejects.toMatchObject({
      code: 'undo-consumed',
    })
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('resumes a partially applied undo on the next call', async () => {
    const created = await touch('later.txt', 'created-later')
    // The capture says the file did not exist at the anchor: the rewind deletes
    // it, so the undo must recreate it.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: created, before: null })
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-retry' })

    // Make the rescue copy unreadable: the undo's write fails mid-op even
    // though the journal itself is intact. (Deleting the file the journal
    // needs is a real failure mode — a partially cleaned store directory.)
    const journalName = (await readdir(store.sessionDir(session))).find(name => name.includes('op-retry'))
    if (journalName === undefined) throw new Error('expected the retry journal')
    const journalPath = join(store.sessionDir(session), journalName)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      state: string
      actions: { rescue: { blob?: string } | string | null }[]
    }
    const rescue = journal.actions[0]!.rescue
    const rescueRef = typeof rescue === 'string' ? rescue : rescue?.blob
    if (rescueRef === undefined) throw new Error('expected a rescue copy')
    const rescuePath = join(store.sessionDir(session), rescueRef)
    const rescueBytes = await readFile(rescuePath)
    await rm(rescuePath, { force: true })

    const first = await store.undoRestore(session, 'op-retry', unlink)
    expect(first.failed).toHaveLength(1)
    const interrupted = JSON.parse(await readFile(journalPath, 'utf8')) as { state: string }
    expect(interrupted.state).toBe('recovery-required')

    // The underlying problem is repaired; the next call resumes the rollback.
    await writeFile(rescuePath, rescueBytes)
    const second = await store.undoRestore(session, 'op-retry', unlink)
    expect(second.failed).toEqual([])
    expect(await readFile(created, 'utf8')).toBe('created-later')
  })

  it('retires the older undo record when a newer rewind starts', async () => {
    const first = await touch('first.txt', 'v0')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: first, before: 'v0' })
    await writeFile(first, 'v1', 'utf8')
    await store.restoreAfter(session, 5, unlink, undefined, { opId: 'op-old' })
    expect(await readFile(first, 'utf8')).toBe('v0')

    // A second rewind supersedes the first one's undo record.
    const second = await touch('second.txt', 'w0')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: second, before: 'w0' })
    await writeFile(second, 'w1', 'utf8')
    await store.restoreAfter(session, 6, unlink, undefined, { opId: 'op-new' })
    expect(await readFile(second, 'utf8')).toBe('w0')

    await expect(store.undoRestore(session, 'op-old', unlink)).rejects.toMatchObject({
      code: 'undo-unavailable',
      reason: 'journal-missing',
    })
    const undone = await store.undoRestore(session, 'op-new', unlink)
    expect(undone.failed).toEqual([])
    expect(await readFile(second, 'utf8')).toBe('w1')
  })
})
