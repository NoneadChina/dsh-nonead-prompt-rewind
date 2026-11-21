import { mkdtemp, readFile, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MIN_ANCHOR_GROUPS, SnapshotStore } from '../src/snapshot.ts'

const DAY = 86_400_000

describe('snapshot retention horizon', () => {
  let root: string
  let store: SnapshotStore
  const session = 'horizon-session'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rewind-horizon-'))
    store = new SnapshotStore(root, {
      retentionDays: 7,
      maxSessionBytes: 0,
      maxTotalBytes: 0,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function touch(name: string, content: string): Promise<string> {
    const file = join(root, name)
    await writeFile(file, content, 'utf8')
    return file
  }

  /** Record one checkpoint for `seq`, then optionally backdate its anchor dir. */
  async function anchor(seq: number, ageDays = 0): Promise<void> {
    const file = await touch(`file-${seq}.txt`, `body-${seq}`)
    await store.recordEntry(session, { callId: `c${seq}`, anchorSeq: seq, path: file, before: `body-${seq}` })
    if (ageDays === 0) return
    const t = new Date(Date.now() - ageDays * DAY)
    const dir = join(store.sessionDir(session), String(seq))
    for (const name of await readdir(dir)) await utimes(join(dir, name), t, t)
    await utimes(dir, t, t)
  }

  it('evicts groups older than the horizon and records the watermark', async () => {
    for (let seq = 1; seq <= 35; seq++) await anchor(seq, seq <= 5 ? 10 : 0)
    await store.prune(session, 100, { horizonDays: 7 })

    const kept = (await readdir(store.sessionDir(session))).filter(name => /^\d+$/.test(name))
    expect(kept).not.toContain('1')
    expect(kept).not.toContain('5')
    expect(kept).toContain('6')
    expect(kept).toContain('35')
    // The floor keeps the newest N groups even when they are older than the horizon.
    expect(kept).toHaveLength(DEFAULT_MIN_ANCHOR_GROUPS)
    expect(await store.readPrunedThrough(session)).toBe(5)
  })

  it('never keeps more than the newest group floor when every group is stale', async () => {
    for (let seq = 1; seq <= 40; seq++) await anchor(seq, 30)
    await store.prune(session, 100, { horizonDays: 7 })

    const kept = (await readdir(store.sessionDir(session))).filter(name => /^\d+$/.test(name))
    expect(kept).toHaveLength(DEFAULT_MIN_ANCHOR_GROUPS)
    expect(kept).toContain('11')
    expect(kept).not.toContain('10')
    expect(await store.readPrunedThrough(session)).toBe(10)
  })

  it('advances the watermark but never moves it backwards', async () => {
    for (let seq = 1; seq <= 40; seq++) await anchor(seq, seq <= 10 ? 10 : 0)
    await store.prune(session, 100, { horizonDays: 7 })
    expect(await store.readPrunedThrough(session)).toBe(10)

    // A later, tighter count-only prune must raise the watermark to its own
    // highest evicted group.
    await store.prune(session, 14)
    expect(await store.readPrunedThrough(session)).toBe(26)

    // A wider prune afterwards cannot lower it.
    await store.prune(session, 100)
    expect(await store.readPrunedThrough(session)).toBe(26)
  })

  it('reports zero when no group was ever evicted', async () => {
    await anchor(1)
    expect(await store.readPrunedThrough(session)).toBe(0)
    expect(await store.readPrunedThrough('never-seen')).toBe(0)
  })

  it('treats a non-numeric or corrupt marker as "never pruned"', async () => {
    await anchor(1)
    await writeFile(join(store.sessionDir(session), 'pruned'), 'not-a-number', 'utf8')
    expect(await store.readPrunedThrough(session)).toBe(0)
  })

  it('disables the horizon when the configured window is zero', async () => {
    for (let seq = 1; seq <= 35; seq++) await anchor(seq, 30)
    await store.prune(session, 100, { horizonDays: 0 })

    const kept = (await readdir(store.sessionDir(session))).filter(name => /^\d+$/.test(name))
    expect(kept).toHaveLength(35)
    expect(await store.readPrunedThrough(session)).toBe(0)
  })

  it('applies the configured horizon from the normal commit path', async () => {
    for (let seq = 1; seq <= 31; seq++) await anchor(seq, seq === 1 ? 10 : 0)
    // Commit-path pruning is debounced (1s), so let the window elapse before the
    // next commit; the first commit above already consumed the first slot.
    await new Promise(resolve => setTimeout(resolve, 1100))
    await anchor(32)

    expect(await store.exists(join(store.sessionDir(session), '1'))).toBe(false)
    expect(await store.readPrunedThrough(session)).toBe(1)
    expect(await store.exists(join(store.sessionDir(session), '2'))).toBe(true)
  })

  it('keeps the watermark beside the store markers without being read as an entry', async () => {
    await anchor(1)
    // A non-numeric file in a session dir must not break entry listing.
    await mkdir(join(store.sessionDir(session), 'pruned.tmp'), { recursive: true })
    const entries = await store.entriesAfter(session, 0)
    expect(entries).toHaveLength(1)
  })
})

describe('pruned watermark on disk', () => {
  it('writes the highest evicted anchor sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-watermark-'))
    const store = new SnapshotStore(root, { maxSessionBytes: 0, maxTotalBytes: 0 })
    try {
      const file = join(root, 'a.txt')
      await writeFile(file, 'x', 'utf8')
      for (let seq = 1; seq <= 3; seq++) {
        await store.recordEntry('s', { callId: `c${seq}`, anchorSeq: seq, path: file, before: 'x' })
      }
      await store.prune('s', 1)
      expect(await readFile(join(store.sessionDir('s'), 'pruned'), 'utf8')).toBe('2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
