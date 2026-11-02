/**
 * Probes for the rewind conversation archive: seq flattening (a merged surface
 * node arrives as a nested group), what the renderer keeps, and path safety.
 *
 * The archive is the recovery path for a rewind's folded-away dialogue — the
 * surface cannot be unfolded — so both the grouping bug and an escaping path
 * would silently lose the user's content.
 */
import { describe, expect, it } from 'vitest'
import { archiveRef, flattenShadowedSeqs, renderArchiveMarkdown, resolveArchivePath } from '../src/archive.ts'
import { readRewindArchive, writeRewindArchive } from '../src/archive-store.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ev = (seq: number, type: string, data: unknown, time = 1_700_000_000_000) => ({ seq, type, time, data })

describe('shadowed seq flattening', () => {
  it('expands a grouped surface node instead of dropping it', () => {
    // Real log form: `[[922,924],927,929]` — 922 is the user message and 924 the
    // runtime-context injection appended right after it, merged into one node.
    // Reading only the scalars lost EVERY user message before this fix.
    expect(flattenShadowedSeqs([[922, 924], 927, 929])).toEqual([922, 924, 927, 929])
  })

  it('de-duplicates while keeping the original order', () => {
    expect(flattenShadowedSeqs([3, [3, 4], 2])).toEqual([3, 4, 2])
  })
})

describe('archive rendering', () => {
  it('keeps human prompts and assistant text, drops injections, folds tools', () => {
    const { markdown, stats } = renderArchiveMarkdown({
      sessionId: 's1',
      opId: 'op-1',
      targetSeq: 3,
      at: 1_700_000_000_000,
      events: [
        ev(1, 'user/message', { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } }),
        ev(2, 'user/message', { content: [{ type: 'text', text: 'runtime context noise' }], source: { kind: 'runtime-context' } }),
        ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'the answer' }] } }),
        ev(4, 'tool/result', { message: { toolCallId: 'call-1', content: [] } }),
      ],
      shadowedSeqs: [[1, 2], 3, 4],
    })
    expect(stats).toEqual({ users: 1, assistants: 1, tools: 1, total: 3 })
    expect(markdown).toContain('hello there')
    expect(markdown).toContain('the answer')
    expect(markdown).toContain('call-1')
    expect(markdown).not.toContain('runtime context noise')
  })

  it('skips events whose seq is gone from the log', () => {
    const { stats } = renderArchiveMarkdown({
      sessionId: 's1', opId: 'op-1', targetSeq: 1, at: 0,
      events: [ev(1, 'user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
      shadowedSeqs: [1, 99],
    })
    expect(stats.users).toBe(1)
    expect(stats.total).toBe(1)
  })
})

describe('archive path safety', () => {
  it('sanitizes both segments', () => {
    expect(archiveRef('s/1', '1793-abc')).toEqual({ relativePath: 's_1/1793-abc.md' })
  })

  it('refuses anything that would escape the archive root', () => {
    expect(resolveArchivePath('C:/root', '../x.md')).toBeUndefined()
    expect(resolveArchivePath('C:/root', '/etc/passwd')).toBeUndefined()
    expect(resolveArchivePath('C:/root', 'a/b.md')).toBe('C:/root/a/b.md')
  })
})

describe('archive store round-trip', () => {
  it('writes and reads the same markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewind-archive-'))
    try {
      const written = await writeRewindArchive(root, {
        sessionId: 's1', opId: 'op-1', targetSeq: 5, at: 1_700_000_000_000,
        events: [ev(5, 'user/message', { content: [{ type: 'text', text: 'kept' }], source: { kind: 'user' } })],
        shadowedSeqs: [5],
      })
      expect(written?.relativePath).toBe('s1/op-1.md')
      expect(written?.stats.users).toBe(1)
      const back = await readRewindArchive(root, 's1/op-1.md')
      expect(back).toContain('kept')
      // A missing file is "no archive", never a throw.
      expect(await readRewindArchive(root, 's1/nope.md')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
