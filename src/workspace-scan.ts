/**
 * Workspace discovery for the "restore everything" guarantee.
 *
 * The checkpoint store's original tracking rule is "a file enters the tracked
 * set only after a write-class tool (`write` / `edit`) has handled it". That
 * rule is why a file created or dropped by a shell command and later deleted by
 * another shell command could never be restored: the plugin never held any
 * before-image of it, so a rewind had nothing to write back.
 *
 * This module closes that gap from the other side: before a mutating shell
 * command runs, the workspace is walked and every regular file that the store
 * has never recorded becomes a first-sighting backup. From then on the ordinary
 * message-boundary re-check keeps its state current, so a later `rm` /
 * `Remove-Item` can be rewound exactly like a tool edit.
 *
 * The walk is deliberately bounded:
 * - directory names that never carry user source (dependency caches, build
 *   output, VCS internals) are pruned, so a repo with a populated
 *   `node_modules` does not turn into a 200k-file traversal;
 * - a hard file-count cap stops a pathological tree from stalling a tool call;
 * - symlinks are skipped for the same reason restores skip them — a link would
 *   make the backup name and the written name diverge.
 *
 * Discovery only answers "which regular files exist"; sizing, the per-file cap
 * and the actual byte copy stay in the store, so a huge file is rejected there
 * before it is ever read.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory names pruned from the walk (matched case-insensitively). */
export const DEFAULT_SCAN_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'vendor',
  '.idea',
  '.vscode',
]

/** Byte-size ceiling for the whole walk: keeps a tool call responsive. */
export const DEFAULT_SCAN_MAX_FILES = 5000

/**
 * Byte budget for one first-sighting pass. A workspace holding screen
 * recordings, datasets or model weights must not turn the first shell command
 * into a multi-gigabyte copy; once the budget is reached the remaining files
 * stay untracked (they are offered again by the next command).
 */
export const DEFAULT_SCAN_MAX_BYTES = 200 * 1024 * 1024

/** Directory-depth ceiling, so a deep tree cannot recurse without bound. */
export const DEFAULT_SCAN_MAX_DEPTH = 10

/** Options for {@link discoverWorkspaceFiles}. */
export interface WorkspaceScanOptions {
  /** Directory names to prune (defaults to {@link DEFAULT_SCAN_EXCLUDED_DIRS}). */
  excludeDirs?: readonly string[]
  /** Hard cap on returned files (defaults to {@link DEFAULT_SCAN_MAX_FILES}). */
  maxFiles?: number
  /** Maximum directory depth below `root` (defaults to {@link DEFAULT_SCAN_MAX_DEPTH}). */
  maxDepth?: number
}

/**
 * List the regular files under `root`, depth-first, with caches and build
 * output pruned.
 *
 * Symlinks are skipped (both to directories and to files): a restore refuses a
 * linked path, so backing one up would only spend bytes on something that can
 * never be written back. An unreadable directory is skipped rather than thrown:
 * discovery is an optimisation over the tracked set, never a hard dependency of
 * the tool call it precedes.
 *
 * @param root - absolute directory to walk.
 * @param options - pruning and bound configuration.
 * @returns absolute paths of regular files, at most `maxFiles` of them.
 */
export async function discoverWorkspaceFiles(
  root: string,
  options: WorkspaceScanOptions = {},
): Promise<string[]> {
  const excluded = new Set(
    (options.excludeDirs ?? DEFAULT_SCAN_EXCLUDED_DIRS).map(name => name.toLowerCase()),
  )
  const maxFiles = options.maxFiles ?? DEFAULT_SCAN_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_MAX_DEPTH
  const found: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= maxFiles) return
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, transient IO): skip it, never abort.
      return
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return
      // `withFileTypes` reports a symlink as `isSymbolicLink()`, so both the
      // directory and the file branch below stay link-free without an lstat.
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      found.push(full)
    }
  }

  // The root itself must be a directory; a file or a missing path yields [].
  try {
    const rootInfo = await stat(root)
    if (!rootInfo.isDirectory()) return []
  } catch {
    return []
  }
  await walk(root, 0)
  return found
}
