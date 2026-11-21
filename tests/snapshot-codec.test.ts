/**
 * Store v3 text codec: a text sidecar that brotli actually shrinks is stored
 * packed, and every reader (entry metadata, restore, journal refs) undoes the
 * codec. Binary sidecars and tiny files stay raw: compression is an option on
 * top of the byte-exact format, never a second content model.
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, isLinkEntry, SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-codec'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-codec-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, bytes: Buffer): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}

async function captureAndRecord(callId: string, anchorSeq: number, live: string): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind === 'failed') throw new Error(copied.message)
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    copied.kind === 'absent' ? null : { file: staged, size: copied.size })
}

/** Locate the single committed sidecar of an anchor group. */
async function sidecarFor(anchor: number): Promise<{ entry: string; sidecar: string }> {
  const dir = join(root, session, String(anchor))
  const names = (await (await import('node:fs/promises')).readdir(dir))
  const entry = names.find(name => name.endsWith('.json'))!
  const sidecar = names.find(name => name.endsWith('.before'))!
  return { entry: join(dir, entry), sidecar: join(dir, sidecar) }
}

describe('packed text sidecars', () => {
  it('packs compressible text and records the codec with the logical size', async () => {
    const text = 'the same line of source text, repeated to compress well\n'.repeat(120)
    const bytes = Buffer.from(text, 'utf8')
    const live = await touch('note.txt', bytes)
    await captureAndRecord('c1', 1, live)

    const { entry, sidecar } = await sidecarFor(1)
    const json = JSON.parse(await readFile(entry, 'utf8')) as Record<string, unknown>
    expect(json.store).toBe(3)
    expect(json.codec).toBe('br')
    expect(json.size).toBe(bytes.length)

    const stored = await stat(sidecar)
    expect(stored.size).toBeLessThan(bytes.length)
    expect(brotliDecompressSync(await readFile(sidecar))).toEqual(bytes)

    const [committed] = await store.entriesAfter(session, 1)
    if (committed === undefined || isLinkEntry(committed)) throw new Error('expected a real entry')
    expect(committed.size).toBe(bytes.length)
    expect(committed.before?.kind).toBe('blob')
    expect(committed.before?.kind === 'blob' ? committed.before.codec : undefined).toBe('br')
  })

  it('restores packed text byte-exactly', async () => {
    const text = 'const repeated = 1\n'.repeat(300)
    const live = await touch('source.ts', Buffer.from(text, 'utf8'))
    await captureAndRecord('c1', 1, live)
    await writeFile(live, 'clobbered by the edit that follows', 'utf8')

    const outcome = await store.restoreAfter(session, 1, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe(text)
  })

  it('leaves incompressible binary raw', async () => {
    const bytes = randomBytes(4096)
    const live = await touch('image.bin', bytes)
    await captureAndRecord('c1', 1, live)

    const { entry, sidecar } = await sidecarFor(1)
    const json = JSON.parse(await readFile(entry, 'utf8')) as Record<string, unknown>
    expect(json.codec).toBeUndefined()
    expect(await readFile(sidecar)).toEqual(bytes)
  })

  it('leaves text below the packing floor raw', async () => {
    const bytes = Buffer.from('short note', 'utf8')
    const live = await touch('short.txt', bytes)
    await captureAndRecord('c1', 1, live)

    const { entry, sidecar } = await sidecarFor(1)
    const json = JSON.parse(await readFile(entry, 'utf8')) as Record<string, unknown>
    expect(json.codec).toBeUndefined()
    expect(await readFile(sidecar)).toEqual(bytes)
  })
})
