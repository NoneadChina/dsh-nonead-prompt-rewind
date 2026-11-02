import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SCAN_MAX_FILES, discoverWorkspaceFiles } from '../src/workspace-scan.ts'

describe('discoverWorkspaceFiles', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rewind-scan-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists regular files recursively', async () => {
    await writeFile(join(root, 'a.ts'), 'a')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'b.ts'), 'b')
    const files = await discoverWorkspaceFiles(root)
    expect(files).toHaveLength(2)
    expect(files.some(f => f.endsWith('a.ts'))).toBe(true)
    expect(files.some(f => f.endsWith('b.ts'))).toBe(true)
  })

  it('prunes dependency and build directories', async () => {
    await writeFile(join(root, 'keep.ts'), 'k')
    for (const dir of ['node_modules', 'dist', '.git']) {
      await mkdir(join(root, dir))
      await writeFile(join(root, dir, 'ignored.ts'), 'x')
    }
    const files = await discoverWorkspaceFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0]?.endsWith('keep.ts')).toBe(true)
  })

  it('honours a custom exclusion list', async () => {
    await writeFile(join(root, 'keep.ts'), 'k')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'big.bin'), 'x')
    const files = await discoverWorkspaceFiles(root, { excludeDirs: ['assets'] })
    expect(files).toHaveLength(1)
  })

  it('skips symlinks', async () => {
    await writeFile(join(root, 'real.ts'), 'r')
    try {
      await symlink(join(root, 'real.ts'), join(root, 'link.ts'))
    } catch {
      return // Windows without developer mode: nothing to assert.
    }
    const files = await discoverWorkspaceFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0]?.endsWith('real.ts')).toBe(true)
  })

  it('stops at the file cap', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.ts`), 'x')
    const files = await discoverWorkspaceFiles(root, { maxFiles: 3 })
    expect(files).toHaveLength(3)
  })

  it('returns an empty list for a missing root', async () => {
    const files = await discoverWorkspaceFiles(join(root, 'nope'))
    expect(files).toEqual([])
  })

  it('exposes a positive default cap', () => {
    expect(DEFAULT_SCAN_MAX_FILES).toBeGreaterThan(0)
  })
})
