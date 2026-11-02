/**
 * Disk half of the rewind archive: write one markdown file, read it back later.
 *
 * Kept separate from `archive.ts` (pure rendering) so the renderer stays
 * testable without a filesystem. Every failure here is swallowed by the caller:
 * an archive is a convenience, and it must never turn a successful rewind into
 * an error.
 *
 * @module dsh-nonead-prompt-rewind/archive-store
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { archiveRef, renderArchiveMarkdown, resolveArchivePath, type ArchiveInput, type ArchiveStats } from './archive.ts'

/** What one write produced. */
export interface ArchiveWrite {
  /** Path relative to the archive root: `<sessionId>/<opId>.md`. */
  readonly relativePath: string
  /** Rendered counters (for the rewind result line / logging). */
  readonly stats: ArchiveStats
}

/**
 * Render and persist one archive.
 *
 * @param root - archive root directory (absolute).
 * @param input - the session slice to archive.
 * @returns the written reference, or undefined when the path is unsafe or the
 *   write fails (the caller treats both as "no archive").
 */
export async function writeRewindArchive(root: string, input: ArchiveInput): Promise<ArchiveWrite | undefined> {
  const ref = archiveRef(input.sessionId, input.opId)
  const absolute = resolveArchivePath(root, ref.relativePath)
  if (absolute === undefined) return undefined
  try {
    const { markdown, stats } = renderArchiveMarkdown(input)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, markdown, 'utf8')
    return { relativePath: ref.relativePath, stats }
  } catch {
    return undefined
  }
}

/**
 * Read one archive back by its stored reference.
 * @param root - archive root directory (absolute).
 * @param relativePath - a value previously returned by {@link writeRewindArchive}.
 * @returns the markdown, or undefined when the reference is unsafe or unreadable.
 */
export async function readRewindArchive(root: string, relativePath: string): Promise<string | undefined> {
  const absolute = resolveArchivePath(root, relativePath)
  if (absolute === undefined) return undefined
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return undefined
  }
}
