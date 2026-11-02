/**
 * Rewind history: one audit record per rewind attempt, partitioned by
 * workspace, bounded per partition.
 *
 * Layout (docs/DEVELOPMENT-GUIDE.zh.md §6.2):
 *
 *   <root>/<workspaceKey>/history.json
 *
 * Each partition keeps the newest `limit` entries (`historyLimit`, default 10).
 * Everything here is host-side and fs-only: the client reads it over the
 * `history` RPC endpoint, never from disk.
 *
 * Invariants:
 * - Writing history NEVER changes a rewind's outcome: callers fire-and-forget
 *   and this module swallows nothing but reports through `onWarn`.
 * - One partition is one file: read-modify-write runs inside a per-path queue,
 *   and the write is tmp+rename (never half-written).
 * - A corrupt file is renamed aside (`history.json.corrupt-<epoch>`) and
 *   replaced with an empty partition — never silently deleted.
 *
 * @module dsh-rewind/history
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** On-disk history schema. */
export const HISTORY_FILE_VERSION = 1 as const

/** File name inside one partition. */
export const HISTORY_FILE = 'history.json'

/** Default partition directory name segment for sessions without a workspace. */
const UNKNOWN_KEY = '_unknown'

/** One workspace partition identity, as stored inside the file. */
export interface HistoryWorkspace {
  readonly key: string
  readonly workspaceId?: string
  readonly path?: string
}

/** Which half of a rewind actually moved. */
export type HistoryOutcome = 'success' | 'failed' | 'partial'

/** How the undo restored state. */
export type UndoMode = 'files' | 'files+refill' | 'files+resend'

/** One rewind attempt. */
export interface HistoryEntry {
  /** `${at}-${randomUUID().slice(0,8)}` */
  readonly opId: string
  /** Redundant copy of the partition key (guards hand-moved files). */
  readonly workspaceKey: string
  readonly workspaceId?: string
  readonly sessionId: string
  readonly sessionTitle?: string
  readonly at: number
  readonly targetSeq: number
  /** Whether this rewind actually touched files (a journal exists ⇒ undoable). */
  readonly hadFiles: boolean
  readonly outcome: HistoryOutcome
  /** Number of log events shadowed by the marker. */
  readonly shadowedEvents: number
  /** Target message text, newlines collapsed, at most 80 chars. */
  readonly messagePreview: string
  readonly attachments: number
  readonly files?: {
    readonly restored: number
    readonly deleted: number
    readonly skipped: number
    readonly uncovered: number
    /** At most 20 affected paths, relative forms, tail truncated by the reader. */
    readonly preview: readonly string[]
  }
  readonly errorCode?: string
  /** Host-rendered reason, at most 200 chars. */
  readonly errorText?: string
  /** Previous non-undone entry of the same session (the rewind chain). */
  readonly chainPrev?: string
  /**
   * Archive of the folded-away conversation, relative to the archive root
   * (`<sessionId>/<opId>.md`). Absent when archiving was off or failed.
   */
  readonly archivePath?: string
  /** `journal + rescue` still on disk at write time. */
  undoable: boolean
  /** Set once: an entry may be undone at most once. */
  undoneAt?: number
  undoOutcome?: 'success' | 'partial'
  undoMode?: UndoMode
}

/** One partition file. */
export interface HistoryFile {
  readonly version: typeof HISTORY_FILE_VERSION
  readonly workspace: HistoryWorkspace
  entries: HistoryEntry[]
}

/** Constructor options. */
export interface HistoryOptions {
  /** `<dsh home>/rewind-history` (created on demand). */
  readonly root: string
  /** Per-partition cap (the caller's `historyLimit`). */
  readonly limit: number
  /** Whether to record the message preview at all (`historyPreview`). */
  readonly preview: boolean
  /** Injectable clock (tests). */
  readonly now?: () => number
  /** Injectable warning sink (tests). */
  readonly onWarn?: (message: string, detail?: unknown) => void
}

/**
 * A workspace record as the host's registry exposes it.
 *
 * `workspaceRegistry.list()` serves `Workspace` ENTITIES, whose identifier
 * field is `id`; `workspaceId` is the spelling used by the RPC `WorkspaceView`
 * and by older registry shapes. Both are accepted so the reverse lookup keeps
 * working across DSH lines: reading only `workspaceId` yielded `undefined`,
 * which blew up inside `safeKeySegment` as
 * "Cannot read properties of undefined (reading 'replace')".
 */
export interface WorkspaceLike {
  readonly id?: string
  readonly workspaceId?: string
  readonly path?: string
  readonly sessionIds?: readonly string[]
}

/**
 * The identifier a registry record carries, under either spelling.
 * @param workspace - one registry record.
 * @returns the non-empty identifier, or undefined when the record has none.
 */
export function workspaceIdOf(workspace: WorkspaceLike): string | undefined {
  const id = workspace.id ?? workspace.workspaceId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Cap on the per-entry path preview list. */
export const PREVIEW_PATH_LIMIT = 20

/** Cap on the stored message preview. */
export const PREVIEW_TEXT_LIMIT = 80

/** Cap on the stored host error text. */
export const ERROR_TEXT_LIMIT = 200

/** Hard ceiling of one partition file (defends against a corrupted preview). */
export const PARTITION_BYTES_CAP = 512 * 1024

/**
 * Resolve the partition key for a session from the Host workspace registry.
 * The Session object carries no `workspaceId` (verified on 0.2.2-alpha.2), so
 * ownership is a reverse lookup over `WorkspaceView.sessionIds`.
 *
 * @returns `ws-<id>` when accounted to a workspace, else undefined.
 */
export function workspaceKeyFromRegistry(
  sessionId: string,
  workspaces: readonly WorkspaceLike[] | undefined,
): { readonly key: string; readonly workspace: WorkspaceLike } | undefined {
  if (workspaces === undefined) return undefined
  const hit = workspaces.find(workspace => workspace.sessionIds?.includes(sessionId) === true)
  if (hit === undefined) return undefined
  const id = workspaceIdOf(hit)
  // A record without an identifier cannot name a partition; fall back to the
  // shared `_unknown` partition instead of inventing `ws-_`.
  if (id === undefined) return undefined
  return { key: `ws-${safeKeySegment(id)}`, workspace: hit }
}

/**
 * Derive a partition key from a directory when no workspace accounts for the
 * session. The caller MUST pass a canonical (realpath'd) directory: the raw
 * cwd string differs by case, short name, separator and drive spelling.
 */
export function cwdKey(canonicalDirectory: string): string {
  const digest = createHash('sha256').update(canonicalDirectory).digest('hex').slice(0, 12)
  return `cwd-${digest}`
}

/** The fallback partition for a session with neither workspace nor a directory. */
export function unknownKey(): string {
  return UNKNOWN_KEY
}

/** Keep only `[a-zA-Z0-9._-]`, reject `.` / `..` and empty results. */
export function safeKeySegment(raw: string | undefined): string {
  // A registry record may omit its identifier on a newer DSH line; never let
  // that surface as a TypeError in the middle of a rewind.
  if (typeof raw !== 'string') return '_'
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return '_'
  return cleaned
}

/** Collapse whitespace/newlines and cap the stored message preview. */
export function previewText(text: string, enabled: boolean): string {
  if (!enabled) return ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > PREVIEW_TEXT_LIMIT ? collapsed.slice(0, PREVIEW_TEXT_LIMIT) : collapsed
}

/** Cap the stored host error text. */
export function errorText(text: string): string {
  return text.length > ERROR_TEXT_LIMIT ? text.slice(0, ERROR_TEXT_LIMIT) : text
}

/** Build a fresh entry id. */
export function newOpId(at: number): string {
  return `${at}-${randomUUID().slice(0, 8)}`
}

/** One empty partition. */
function emptyFile(workspace: HistoryWorkspace): HistoryFile {
  return { version: HISTORY_FILE_VERSION, workspace, entries: [] }
}

/** True when `value` looks like a serialized entry (defensive read). */
function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['opId'] === 'string'
    && typeof record['sessionId'] === 'string'
    && typeof record['workspaceKey'] === 'string'
    && typeof record['at'] === 'number'
    && typeof record['targetSeq'] === 'number'
}

/**
 * The bounded, partitioned history store. One instance per plugin mount; all
 * writes for one partition serialize through a per-path promise chain.
 */
export class HistoryStore {
  private readonly root: string
  private readonly limit: number
  private readonly preview: boolean
  private readonly clock: () => number
  private readonly warn: (message: string, detail?: unknown) => void
  /** Per-partition write chain; failures do not poison the next write. */
  private readonly queue = new Map<string, Promise<unknown>>()
  /** Set by {@link dispose}: no further write may start. */
  private disposed = false

  constructor(options: HistoryOptions) {
    this.root = options.root
    // A non-positive/garbage limit falls back to the documented default rather
    // than writing an unbounded file.
    this.limit = Number.isSafeInteger(options.limit) && options.limit >= 1 ? options.limit : 10
    this.preview = options.preview
    this.clock = options.now ?? (() => Date.now())
    this.warn = options.onWarn ?? (() => {})
  }

  /** Absolute path of one partition file. */
  partitionPath(key: string): string {
    return join(this.root, safeKeySegment(key), HISTORY_FILE)
  }

  /**
   * Read one partition. Missing or unreadable files yield an empty partition;
   * a corrupt file is moved aside first (never deleted).
   */
  async read(key: string): Promise<HistoryFile> {
    const file = this.partitionPath(key)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyFile({ key: safeKeySegment(key) })
      }
      this.warn('history read failed', error)
      return emptyFile({ key: safeKeySegment(key) })
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      const record = parsed as Record<string, unknown>
      if (record['version'] !== HISTORY_FILE_VERSION) throw new Error(`unknown history version: ${String(record['version'])}`)
      const entries = Array.isArray(record['entries']) ? record['entries'].filter(isEntry) : []
      const workspaceRaw = record['workspace']
      const workspace: HistoryWorkspace = typeof workspaceRaw === 'object' && workspaceRaw !== null
        ? {
            key: typeof (workspaceRaw as Record<string, unknown>)['key'] === 'string'
              ? (workspaceRaw as Record<string, unknown>)['key'] as string
              : safeKeySegment(key),
            ...(typeof (workspaceRaw as Record<string, unknown>)['workspaceId'] === 'string'
              ? { workspaceId: (workspaceRaw as Record<string, unknown>)['workspaceId'] as string } : {}),
            ...(typeof (workspaceRaw as Record<string, unknown>)['path'] === 'string'
              ? { path: (workspaceRaw as Record<string, unknown>)['path'] as string } : {}),
          }
        : { key: safeKeySegment(key) }
      return { version: HISTORY_FILE_VERSION, workspace, entries }
    } catch (error) {
      // Never silent: keep the evidence and start a fresh partition.
      const aside = `${file}.corrupt-${this.clock()}`
      try {
        await rename(file, aside)
        this.warn(`history partition moved aside as ${aside}`, error)
      } catch (renameError) {
        this.warn('history partition corrupt and could not be moved aside', renameError)
      }
      return emptyFile({ key: safeKeySegment(key) })
    }
  }

  /** List one partition's entries, oldest first. */
  async list(key: string): Promise<HistoryEntry[]> {
    return (await this.read(key)).entries
  }

  /**
   * Append one entry to its partition, trimming the oldest overflow inside the
   * same serialized write. Never rejects: a history failure must not fail the
   * rewind that produced it.
   */
  async append(entry: HistoryEntry): Promise<boolean> {
    if (this.disposed) return false
    const key = entry.workspaceKey
    const file = this.partitionPath(key)
    try {
      await this.enqueue(file, async () => {
        const current = await this.read(key)
        current.entries.push(entry)
        // One splice trims everything past the cap (never a shift loop).
        if (current.entries.length > this.limit) {
          current.entries.splice(0, current.entries.length - this.limit)
        }
        await this.writeAtomic(file, current)
      })
      return true
    } catch (error) {
      this.warn('history append failed', error)
      return false
    }
  }

  /** Clear one partition; returns how many entries were removed. */
  async clear(key: string): Promise<number> {
    const file = this.partitionPath(key)
    let removed = 0
    await this.enqueue(file, async () => {
      const current = await this.read(key)
      removed = current.entries.length
      await this.writeAtomic(file, emptyFile(current.workspace))
    })
    return removed
  }

  /**
   * Patch one entry in place (undo bookkeeping). Returns false when the entry
   * is gone (trimmed away between the UI read and the click).
   */
  async patch(key: string, opId: string, patch: Partial<HistoryEntry>): Promise<boolean> {
    const file = this.partitionPath(key)
    let found = false
    await this.enqueue(file, async () => {
      const current = await this.read(key)
      const index = current.entries.findIndex(entry => entry.opId === opId)
      if (index === -1) return
      found = true
      current.entries[index] = { ...current.entries[index]!, ...patch }
      await this.writeAtomic(file, current)
    })
    return found
  }

  /** The newest not-yet-undone entry of one session (the rewind chain tail). */
  static chainTail(entries: readonly HistoryEntry[], sessionId: string): HistoryEntry | undefined {
    let tail: HistoryEntry | undefined
    for (const entry of entries) {
      if (entry.sessionId !== sessionId || entry.undoneAt !== undefined) continue
      if (tail === undefined || entry.at >= tail.at) tail = entry
    }
    return tail
  }

  /** Whether `entry` is the chain tail (the only undoable position). */
  static isChainTail(entries: readonly HistoryEntry[], entry: HistoryEntry): boolean {
    return HistoryStore.chainTail(entries, entry.sessionId)?.opId === entry.opId
  }

  /** The previous not-undone entry of the same session, for `chainPrev`. */
  static previousOf(entries: readonly HistoryEntry[], sessionId: string): string | undefined {
    return HistoryStore.chainTail(entries, sessionId)?.opId
  }

  /**
   * Stop accepting writes and wait for the in-flight ones to settle. Called
   * from the plugin's disposer: a fire-and-forget append that lands after the
   * harness started tearing the data directory down races the cleanup and can
   * fail an otherwise clean unload (observed as ENOTEMPTY on Windows).
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.queue.values()].map(pending => pending.catch(() => undefined)))
    this.queue.clear()
  }

  /**
   * Serialize one write per partition path. A rejected predecessor must not
   * block its successor, so both branches continue the chain.
   */
  private enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(path) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queue.set(path, next.catch(() => undefined))
    return next
  }

  /** Write tmp + rename, with the size cap applied to the serialized body. */
  private async writeAtomic(file: string, data: HistoryFile): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    let body = JSON.stringify(data)
    if (body.length > PARTITION_BYTES_CAP) {
      // Defensive: a corrupted preview/path list would otherwise grow the file
      // without bound. Keep the newest entries that fit, and say so.
      const trimmed: HistoryFile = { ...data, entries: [] }
      for (let index = data.entries.length - 1; index >= 0; index -= 1) {
        trimmed.entries.unshift(data.entries[index]!)
        const candidate = JSON.stringify(trimmed)
        if (candidate.length > PARTITION_BYTES_CAP) {
          trimmed.entries.shift()
          break
        }
        body = candidate
      }
      this.warn(`history partition exceeded ${PARTITION_BYTES_CAP} bytes; trimmed to ${trimmed.entries.length} entries`)
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
  }
}
