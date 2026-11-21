/**
 * What belongs in a before-image backup.
 *
 * The checkpoint store used to copy every regular file a write-class tool
 * touched (and every workspace file the first-sighting scan found). That is
 * correct for source text and wrong for the bulk of a working tree: rendered
 * PNG frames, browser profiles under `.dsh-tmp`, model weights and build
 * artefacts are either reproducible or never restorable in a useful way, and
 * one PNG sequence can dwarf every source file in the workspace. This module is
 * the single policy that both capture paths consult, so "excluded" means the
 * same thing at the tool boundary, the shell scan and the message-boundary
 * re-check.
 *
 * The policy is deliberately conservative and explainable:
 * - a directory name anywhere in the path (relative to the workspace when the
 *   caller knows it) marks the whole subtree as disposable;
 * - a known binary/media extension is skipped without reading the file;
 * - unknown extensions get a cheap content sniff: a NUL byte in the first
 *   {@link BINARY_SNIFF_BYTES} means binary. UTF-16 BOMs stay text.
 *
 * `includeGlobs` is the escape hatch and wins over every exclusion, including
 * the binary sniff; `excludeGlobs` adds user-defined paths. Glob matching is
 * case-insensitive, `/`-normalized and supports `*`, `**` and `?`.
 *
 * @module dsh-rewind/snapshot-policy
 */

import { open } from 'node:fs/promises'
import { extname } from 'node:path'

/** Bytes read from the head of an unknown file to decide text vs binary. */
export const BINARY_SNIFF_BYTES = 8 * 1024

/** Per-file ceiling for the automatic first-sighting scan (1 MiB). */
export const DEFAULT_SCAN_MAX_FILE_BYTES = 1024 * 1024

/** Per-session snapshot budget (256 MiB), evicted oldest-anchor-first. */
export const DEFAULT_MAX_SESSION_BYTES = 256 * 1024 * 1024

/** Whole-store snapshot budget (2 GiB), evicted least-recently-used first. */
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Directory names that never carry user source worth restoring. Matched
 * case-insensitively as a whole path segment. `.dsh-tmp` is the harness's own
 * scratch area (browser profiles, downloads); `renders` is Blender's default
 * output directory, which is where the multi-gigabyte PNG sequences live.
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  // Dependency caches, VCS internals and build output (mirrors workspace-scan).
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
  // Harness scratch and browser profiles.
  '.dsh-tmp',
  '.dsh',
  '.plugin-fetch',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.cargo',
  'edge-profile',
  'chrome-profile',
  'chromium-profile',
  'firefox-profile',
  // Render output and throwaway directories.
  'renders',
  'render',
  'temp',
  'tmp',
]

/**
 * Extensions that are binary or media by definition: never worth a byte-level
 * before-image for a text rewind, and usually the largest files in the tree.
 */
export const DEFAULT_EXCLUDED_EXTENSIONS: readonly string[] = [
  // Raster images and icons.
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.avif',
  '.ico',
  // Video.
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v',
  // Audio.
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  // Archives and documents.
  '.zip',
  '.7z',
  '.rar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.zst',
  '.pdf',
  // 3D and render artefacts.
  '.glb',
  '.gltf',
  '.blend',
  '.blend1',
  // Databases and logs that are either huge or regenerated.
  '.db',
  '.db-wal',
  '.db-shm',
  '.sqlite',
  '.sqlite3',
  '.pma',
  '.ftz',
  // Model weights and native binaries.
  '.onnx',
  '.pt',
  '.pth',
  '.safetensors',
  '.gguf',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  // Fonts.
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]

export interface SnapshotPolicyOptions {
  /** Extra globs to exclude; matched against the absolute and relative path. */
  readonly excludeGlobs?: readonly string[]
  /** Globs that force inclusion, overriding every exclusion and the sniff. */
  readonly includeGlobs?: readonly string[]
}

/** Why a path was left out of the backup set. */
export type SnapshotSkipReason = 'excluded-dir' | 'excluded-extension' | 'excluded-glob' | 'binary'

/** The policy's answer for one path. */
export type SnapshotPathDecision =
  | { readonly ok: true; readonly included?: true }
  | { readonly ok: false; readonly reason: SnapshotSkipReason }

const EXCLUDED_DIRS = new Set(DEFAULT_EXCLUDED_DIRS)
const EXCLUDED_EXTENSIONS = new Set(DEFAULT_EXCLUDED_EXTENSIONS)

/** Normalize both separators to `/`, collapse repeats; no trailing slash. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
}

/**
 * Compile one glob into an anchored, case-insensitive regexp.
 *
 * `**` crosses separators (and `**\/` also matches zero directories), `*` stays
 * within one segment and `?` matches one non-separator character. Everything
 * else is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = toPosix(pattern)
  let out = '^'
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '*') {
      if (source[i + 1] === '*') {
        i++
        if (source[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`${out}$`, 'i')
}

/** Whether `path` matches any pattern, as an absolute path or workspace-relative. */
function matchesAny(path: string, relative: string | undefined, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern)
    if (regex.test(path)) return true
    if (relative !== undefined && regex.test(relative)) return true
  }
  return false
}

/** Segments of `path`, or of the portion below `root` when it is inside it. */
function segmentsOf(path: string, root: string | undefined): { absolute: string; relative: string | undefined } {
  const absolute = toPosix(path)
  if (root === undefined) return { absolute, relative: undefined }
  const base = toPosix(root)
  if (absolute === base) return { absolute, relative: '' }
  if (absolute.startsWith(`${base}/`)) return { absolute, relative: absolute.slice(base.length + 1) }
  return { absolute, relative: undefined }
}

/**
 * Decide whether one path may be backed up, without reading it.
 * @param path - absolute path being considered.
 * @param policy - user globs.
 * @param workspaceRoot - optional root used to make directory matching relative
 * (so a workspace living under a directory named `tmp` is not excluded wholesale).
 */
export function decideSnapshotPath(
  path: string,
  policy: SnapshotPolicyOptions = {},
  workspaceRoot?: string,
): SnapshotPathDecision {
  const { absolute, relative } = segmentsOf(path, workspaceRoot)
  if (matchesAny(absolute, relative, policy.includeGlobs ?? [])) return { ok: true, included: true }
  if (matchesAny(absolute, relative, policy.excludeGlobs ?? [])) return { ok: false, reason: 'excluded-glob' }
  // Directory exclusions need a workspace-relative view: the absolute path also
  // contains the workspace's own ancestors, and a project legitimately living
  // under `.../Temp` or `.../renders` must not be excluded wholesale. Without a
  // root, only the extension/glob rules apply (a caller that has no root can
  // still refuse media, but cannot tell its ancestors from its contents).
  if (relative !== undefined) {
    const segments = relative.split('/').filter(Boolean)
    for (const segment of segments) {
      if (EXCLUDED_DIRS.has(segment.toLowerCase())) return { ok: false, reason: 'excluded-dir' }
    }
  }
  const extension = extname(absolute).toLowerCase()
  if (EXCLUDED_EXTENSIONS.has(extension)) return { ok: false, reason: 'excluded-extension' }
  return { ok: true }
}

/**
 * Content sniff for an unknown extension: NUL in the head means binary, with a
 * UTF-16 BOM treated as text (those files legitimately contain NUL bytes).
 * A read failure answers `false` so the decision stays with the copy, which
 * will fail loudly on its own.
 */
export function looksBinary(head: Uint8Array): boolean {
  if (head.length >= 2) {
    const bom = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
    if (bom) return false
  }
  for (const byte of head) {
    if (byte === 0) return true
  }
  return false
}

/** Read the first {@link BINARY_SNIFF_BYTES} of `path` and decide text vs binary. */
export async function isBinaryFile(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return looksBinary(buffer.subarray(0, bytesRead))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
