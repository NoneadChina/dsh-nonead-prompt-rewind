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
})
