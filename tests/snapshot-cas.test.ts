/**
 * Store v3: the global content-addressed object pool.
 *
 * Every committed sidecar is hard-linked into `<store>/objects/<sha256>`, so
 * byte-identical captures across sessions share one inode. The pool is a
 * deduplication layer only: entries keep naming their own sidecar, so reading
 * and restoring never depend on the pool. These tests pin that contract plus
 * the garbage collector and the dry-run-by-default migration.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-cas-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const storeRoot = (): string => join(root, 'snap')
const objectsDir = (): string => join(storeRoot(), 'objects')
const sha = (content: string): string => createHash('sha256').update(content).digest('hex')

/** The single sidecar this test captured (entry names carry a call-id digest). */
async function findFile(dir: string, suffix: string): Promise<string> {
  const names = (await readdir(dir)).filter(name => name.endsWith(suffix))
  expect(names).toHaveLength(1)
  return join(dir, names[0]!)
}

const findSidecar = (session: string, anchor = 1): Promise<string> =>
  findFile(join(storeRoot(), session, String(anchor)), '.before')

const findEntry = (session: string, anchor = 1): Promise<string> =>
  findFile(join(storeRoot(), session, String(anchor)), '.json')

async function capture(session: string, callId: string, anchor: number, before: string): Promise<string> {
  const source = join(root, 'ws', session, `${callId}.txt`)
  await mkdir(dirname(source), { recursive: true })
  await writeFile(source, 'live')
  const store = new SnapshotStore(storeRoot())
  await store.recordEntry(session, { callId, anchorSeq: anchor, path: source, before })
  return source
}

describe('content-addressed object pool', () => {
  it('shares one object between sessions capturing identical bytes', async () => {
    await capture('s1', 'c1', 1, 'same bytes')
    await capture('s2', 'c1', 1, 'same bytes')

    const objects = await readdir(objectsDir())
    expect(objects).toEqual([sha('same bytes')])

    const object = await stat(join(objectsDir(), sha('same bytes')))
    const first = await stat(await findSidecar('s1'))
    const second = await stat(await findSidecar('s2'))
    expect(first.ino).toBe(object.ino)
    expect(second.ino).toBe(object.ino)
  })

  it('keeps distinct objects for distinct content', async () => {
    await capture('s1', 'c1', 1, 'alpha')
    await capture('s1', 'c2', 1, 'beta')
    expect((await readdir(objectsDir())).sort()).toEqual([sha('alpha'), sha('beta')].sort())
  })

  it('collects an orphaned object only on a real sweep', async () => {
    await capture('s1', 'c1', 1, 'orphan me')
    await unlink(await findSidecar('s1'))

    const store = new SnapshotStore(storeRoot())
    const dry = await store.gcObjects({ dryRun: true })
    expect(dry).toMatchObject({ scanned: 1, deleted: 1, dryRun: true })
    expect(await readdir(objectsDir())).toEqual([sha('orphan me')])

    const applied = await store.gcObjects()
    expect(applied.deleted).toBe(1)
    expect(await readdir(objectsDir())).toEqual([])
  })

  it('reclaims objects when a whole session is cleared', async () => {
    await capture('s1', 'c1', 1, 'gone')
    const store = new SnapshotStore(storeRoot())
    await store.clearSession('s1')
    expect(await readdir(objectsDir())).toEqual([])
  })
})

describe('migration', () => {
  it('reports reclaimable bytes in a dry run and rewires duplicates on apply', async () => {
    await capture('s1', 'c1', 1, 'duplicate')
    // A pre-v3-style sidecar holding the same bytes under a different inode.
    const legacy = join(storeRoot(), 's2', '1', 'legacy.before')
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, 'duplicate')

    const store = new SnapshotStore(storeRoot())
    const object = join(objectsDir(), sha('duplicate'))
    expect((await stat(legacy)).ino).not.toBe((await stat(object)).ino)

    const dry = await store.migrateObjects({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.deduped).toBe(1)
    expect(dry.reclaimedBytes).toBe(Buffer.byteLength('duplicate'))
    expect((await stat(legacy)).ino).not.toBe((await stat(object)).ino)

    const applied = await store.migrateObjects()
    expect(applied.deduped).toBe(1)
    expect((await stat(legacy)).ino).toBe((await stat(object)).ino)
    expect(applied.gc).toBeDefined()
  })
})

describe('store version', () => {
  it('writes v3 entries and still reads a v2 entry', async () => {
    await capture('s1', 'c1', 1, 'legacy readable')
    const entryFile = await findEntry('s1')
    const parsed = JSON.parse(await readFile(entryFile, 'utf8')) as Record<string, unknown>
    expect(parsed.store).toBe(3)

    parsed.store = 2
    await writeFile(entryFile, JSON.stringify(parsed))

    const store = new SnapshotStore(storeRoot())
    const entries = await store.entriesAfter('s1', 0)
    expect(entries.map(entry => entry.callId)).toEqual(['c1'])
  })

  it('never treats the object pool as a session directory', async () => {
    await capture('s1', 'c1', 1, 'pool not a session')
    const old = new Date(Date.now() - 30 * 86_400_000)
    await utimes(objectsDir(), old, old)

    const store = new SnapshotStore(storeRoot())
    const report = await store.pruneStale({ maxAgeDays: 1 })
    // Only the live session directory is scanned: the pool is not a session.
    expect(report.scanned).toBe(1)
    expect(report.deleted).toBe(0)
    // The pool survives, still linked from the live sidecar.
    expect(await readdir(objectsDir())).toEqual([sha('pool not a session')])
  })
})
