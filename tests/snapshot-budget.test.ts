/**
 * Unit tests for the snapshot capture policy and the byte budgets:
 * what is never captured, what gets evicted when a session or the whole store
 * grows past its cap, and which sessions the eviction must never touch.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-budget-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string | Uint8Array): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return abs
}

const workspace = (): string => join(root, 'ws')

describe('capture policy', () => {
  it('refuses media by extension and remembers the refusal as uncovered', async () => {
    const store = new SnapshotStore(join(root, 'snap'))
    const png = await touch('frames/shot.png', 'not really a png')
    const decision = await store.shouldSnapshot('s1', png, workspace())
    expect(decision).toEqual({ ok: false, reason: 'excluded-extension' })

    const uncovered = await store.uncoveredPaths('s1')
    expect(uncovered).toContainEqual({ path: png, reason: 'excluded', exclusion: 'excluded-extension' })
  })

  it('refuses temporary and render directories relative to the workspace', async () => {
    const store = new SnapshotStore(join(root, 'snap'))
    const rules = await touch('.dsh-tmp/edge-profile/Default/Ruleset Data', 'x')
    const frame = await touch('renders/robot/frame.txt', 'x')
    expect(await store.shouldSnapshot('s1', rules, workspace())).toEqual({ ok: false, reason: 'excluded-dir' })
    expect(await store.shouldSnapshot('s1', frame, workspace())).toEqual({ ok: false, reason: 'excluded-dir' })
  })

  it('does not exclude a workspace that merely lives under a "temp" path segment', async () => {
    const store = new SnapshotStore(join(root, 'snap'))
    // tmpdir() itself contains "Temp" on Windows: the workspace-relative check
    // must not treat the project's own ancestors as excluded content.
    const file = await touch('src/main.ts', 'export {}')
    expect(await store.shouldSnapshot('s1', file, workspace())).toEqual({ ok: true })
  })

  it('sniffs undeclared binaries by NUL byte, and include globs override it', async () => {
    const file = await touch('data/payload.dat', Buffer.from([0x61, 0x00, 0x62]))
    const plain = new SnapshotStore(join(root, 'snap-a'))
    expect(await plain.shouldSnapshot('s1', file, workspace())).toEqual({ ok: false, reason: 'binary' })

    const forced = new SnapshotStore(join(root, 'snap-b'), { includeGlobs: ['**/*.dat'] })
    expect(await forced.shouldSnapshot('s1', file, workspace())).toEqual({ ok: true, included: true })
  })

  it('snapshotBinaries disables the sniff but not the directory/extension rules', async () => {
    const store = new SnapshotStore(join(root, 'snap'), { snapshotBinaries: true })
    const dat = await touch('data/payload.dat', Buffer.from([0x00]))
    const png = await touch('data/shot.png', 'x')
    expect(await store.shouldSnapshot('s1', dat, workspace())).toEqual({ ok: true })
    expect(await store.shouldSnapshot('s1', png, workspace())).toEqual({ ok: false, reason: 'excluded-extension' })
  })
})

describe('byte budgets', () => {
  it('evicts the oldest anchor groups as soon as a session exceeds its budget', async () => {
    const store = new SnapshotStore(join(root, 'snap'), { maxSessionBytes: 2_200 })
    const paths: string[] = []
    for (let anchor = 1; anchor <= 3; anchor++) {
      const file = await touch(`v${anchor}.txt`, `v${anchor}`)
      paths.push(file)
      await store.recordEntry('s1', {
        callId: `c${anchor}`,
        anchorSeq: anchor,
        path: file,
        before: 'x'.repeat(1_000),
      })
    }
    const groups = (await readdir(join(root, 'snap', 's1'))).filter(name => /^\d+$/.test(name))
    // Three ~1 KB groups overflow 2200 bytes: the two oldest go, the newest stays.
    expect(groups).toEqual(['3'])
  })

  it('a single anchor group is never evicted by its own budget', async () => {
    const store = new SnapshotStore(join(root, 'snap'), { maxSessionBytes: 10 })
    const file = await touch('big.txt', 'big')
    await store.recordEntry('s1', { callId: 'c1', anchorSeq: 1, path: file, before: 'x'.repeat(5_000) })
    expect(await readdir(join(root, 'snap', 's1'))).toContain('1')
  })

  it('the whole-store budget evicts idle sessions but never an active one', async () => {
    const store = new SnapshotStore(join(root, 'snap'), { maxSessionBytes: 0, maxTotalBytes: 2_000 })
    const a = await touch('a.txt', 'a')
    const b = await touch('b.txt', 'b')
    await store.recordEntry('active', {
      callId: 'ca',
      anchorSeq: 1,
      path: a,
      before: 'x'.repeat(1_500),
    })
    await store.recordEntry('idle', {
      callId: 'cb',
      anchorSeq: 1,
      path: b,
      before: 'x'.repeat(1_500),
    })
    // Make the idle session strictly older so it sorts first.
    const old = new Date(Date.now() - 60_000)
    await utimes(join(root, 'snap', 'idle'), old, old)
    store.setActiveSessions(['active'])

    await store.enforceTotalBudget()
    const remaining = await readdir(join(root, 'snap'))
    expect(remaining).toContain('active')
    expect(remaining).not.toContain('idle')
  })
})

describe('age sweep with several active sessions', () => {
  async function seed(id: string, ageDays: number): Promise<void> {
    const dir = join(root, 'snap', id, '1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'entry.before')
    await writeFile(file, 'x')
    const then = new Date(Date.now() - ageDays * 86_400_000)
    await utimes(file, then, then)
    await utimes(dir, then, then)
    await utimes(join(root, 'snap', id), then, then)
  }

  it('keeps every active session, not only the one that triggered the sweep', async () => {
    const store = new SnapshotStore(join(root, 'snap'))
    await seed('one', 40)
    await seed('two', 40)
    await seed('gone', 40)
    const report = await store.pruneStale({ keepActiveIds: ['one', 'two'], maxAgeDays: 30 })
    expect(report.deleted).toBe(1)
    expect(report.skippedActive).toBe(2)
    const remaining = await readdir(join(root, 'snap'))
    expect(remaining.sort()).toEqual(['one', 'two'])
  })
})
