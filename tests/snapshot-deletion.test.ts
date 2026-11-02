/**
 * Deletion recovery: a shell command removes a file inside a turn that has no
 * write-before capture of its own. The post-execute pass re-anchors the file's
 * last content blob at that turn, and the rewind to it must then write the file
 * back (before this pass it reported success and changed nothing).
 */
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-deletion'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-del-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

describe('latestContentBlob', () => {
  it('returns the newest content blob strictly before the anchor', async () => {
    const file = await touch('a.txt', 'v1')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v1' })
    await writeFile(file, 'v2', 'utf8')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 7, path: file, before: 'v2' })

    const hit = await store.latestContentBlob(session, file, 9)
    expect(hit).toBeDefined()
    expect(await readFile(hit!.file, 'utf8')).toBe('v2')

    // The boundary is INCLUSIVE: anchor 5 itself qualifies, because the shell
    // deletion pass backs files up at the CURRENT turn and then re-anchors.
    const atFive = await store.latestContentBlob(session, file, 5)
    expect(atFive).toBeDefined()
    expect(await readFile(atFive!.file, 'utf8')).toBe('v1')
    // Nothing recorded at all before the first anchor.
    expect(await store.latestContentBlob(session, file, 4)).toBeUndefined()
  })
})

describe('deletion re-anchor (post-execute pass)', () => {
  it('a rewind to the deleting turn restores the deleted file', async () => {
    const file = await touch('_preview.png', 'PNGDATA')
    // Turn 5: the file exists and was backed up (workspace first sighting).
    await store.recordEntry(session, { callId: 'scan-5-0', anchorSeq: 5, path: file, before: 'PNGDATA' })

    // Turn 7: a shell command deletes it. post-execute re-anchors the blob at 7.
    const previous = await store.latestContentBlob(session, file, 7)
    expect(previous).toBeDefined()
    await rm(file, { force: true })
    const staged = await store.stageCapture(session, 'del-7-0')
    await copyFile(previous!.file, staged)
    await store.recordBackup(session, { callId: 'del-7-0', anchorSeq: 7, path: file }, { file: staged, size: previous!.size })

    // Rewinding to the deleting turn must write the file back.
    const outcome = await store.restoreAfter(session, 7, unlink)
    expect(outcome.restored).toEqual([file])
    expect(outcome.deleted).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('PNGDATA')
  })

  it('leaves a command that deleted nothing untouched', async () => {
    const file = await touch('keep.txt', 'kept')
    await store.recordEntry(session, { callId: 'scan-5-0', anchorSeq: 5, path: file, before: 'kept' })
    const outcome = await store.restoreAfter(session, 7, unlink)
    expect(outcome.restored).toEqual([])
    expect(outcome.deleted).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('kept')
  })
})
