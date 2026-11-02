/**
 * The browser half of the rewind RPC channel: the confirmation dialog's impact
 * preview, the `/rewind` candidate list, and the rewind history the settings
 * section renders. All are host queries, so they travel over Connection RPC
 * instead of the human command channel.
 *
 * @module dsh-rewind/client/host-rpc
 */

import type { RewindCandidate } from './candidates.ts'
import { rewindLog } from './log.ts'

const CHANNEL = '/dsh-rewind'
const TIMEOUT_MS = 8000
/** An undo rewrites files on disk; give it more room than a read. */
const UNDO_TIMEOUT_MS = 20000

/** One file affected by a rewind. */
export interface PreviewFileImpact {
  readonly path: string
  readonly action: 'restore' | 'delete'
}

/** One impact probe resolved, failed, or timed out (`null`). */
export type PreviewOutcome =
  | { readonly kind: 'success'; readonly files: readonly PreviewFileImpact[]; readonly backupOff: boolean }
  | { readonly kind: 'error'; readonly text: string }
  | null

/** Fetch one target's impact through the registered RPC call. */
export type PreviewCall = (sessionId: string, seq: number) => Promise<PreviewOutcome>

type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The slice of the client `connection` service this module reads. */
export interface ConnectionLike {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImpact(value: unknown): value is PreviewFileImpact {
  return isRecord(value)
    && typeof value['path'] === 'string'
    && (value['action'] === 'restore' || value['action'] === 'delete')
}

function isCandidate(value: unknown): value is RewindCandidate {
  return isRecord(value)
    && Number.isSafeInteger(value['seq'])
    && typeof value['time'] === 'number' && Number.isFinite(value['time'])
    && typeof value['preview'] === 'string'
}

function isAbort(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** Resolve one target's file impact over RPC. */
export async function previewOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
  seq: number,
): Promise<PreviewOutcome> {
  if (connection === undefined) return { kind: 'error', text: 'host RPC is unavailable' }
  try {
    const result = await connection.rpc.call(CHANNEL, 'preview', { sessionId, seq }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      rewindLog.warn('preview', `RPC preview failed for @${seq}`, result.error)
      return { kind: 'error', text: result.error.message }
    }
    const value = result.value
    if (!isRecord(value) || typeof value['backupOff'] !== 'boolean'
      || !Array.isArray(value['files']) || !value['files'].every(isImpact)) {
      rewindLog.warn('preview', `RPC preview returned an invalid result for @${seq}`)
      return { kind: 'error', text: 'invalid preview response' }
    }
    return { kind: 'success', files: value['files'], backupOff: value['backupOff'] }
  } catch (error) {
    if (isAbort(error)) {
      rewindLog.warn('preview', `RPC preview timed out for @${seq}`)
      return null
    }
    rewindLog.warn('preview', `RPC preview threw for @${seq}`, error)
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Fetch the full rewind candidate list over RPC. */
export async function candidatesOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
): Promise<readonly RewindCandidate[] | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(CHANNEL, 'candidates', { sessionId }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      rewindLog.warn('preview', 'RPC candidates failed', result.error)
      return undefined
    }
    const value = result.value
    if (!isRecord(value) || !Array.isArray(value['candidates']) || !value['candidates'].every(isCandidate)) {
      rewindLog.warn('preview', 'RPC candidates returned an invalid result')
      return undefined
    }
    return value['candidates']
  } catch (error) {
    rewindLog.warn('preview', 'RPC candidates threw', error)
    return undefined
  }
}

// ---- rewind history (settings section) ----

/** One history entry, as the host serializes it. */
export interface HistoryEntryView {
  readonly opId: string
  readonly workspaceKey: string
  readonly sessionId: string
  readonly sessionTitle?: string
  readonly at: number
  readonly targetSeq: number
  readonly hadFiles: boolean
  readonly outcome: 'success' | 'failed' | 'partial'
  readonly shadowedEvents: number
  readonly messagePreview: string
  readonly attachments: number
  readonly files?: {
    readonly restored: number
    readonly deleted: number
    readonly skipped: number
    readonly uncovered: number
    readonly preview: readonly string[]
  }
  readonly errorCode?: string
  readonly errorText?: string
  readonly chainPrev?: string
  readonly undoable: boolean
  /** Relative path of the folded-away conversation archive, when one exists. */
  readonly archivePath?: string
  readonly undoneAt?: number
  readonly undoOutcome?: 'success' | 'partial'
  readonly undoMode?: 'files' | 'files+refill' | 'files+resend'
}

/** The partition identity plus its entries (newest last). */
export interface HistoryView {
  readonly workspace: { readonly key: string; readonly workspaceId?: string; readonly path?: string }
  readonly entries: readonly HistoryEntryView[]
}

function isHistoryEntry(value: unknown): value is HistoryEntryView {
  return isRecord(value)
    && typeof value['opId'] === 'string'
    && typeof value['sessionId'] === 'string'
    && typeof value['workspaceKey'] === 'string'
    && typeof value['at'] === 'number'
    && typeof value['targetSeq'] === 'number'
    && (value['outcome'] === 'success' || value['outcome'] === 'failed' || value['outcome'] === 'partial')
    && typeof value['undoable'] === 'boolean'
}

/** Read the current workspace's rewind history over RPC. */
export async function historyOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
): Promise<HistoryView | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(CHANNEL, 'history', { sessionId }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      rewindLog.warn('history', 'RPC history failed', result.error)
      return undefined
    }
    const value = result.value
    if (!isRecord(value) || !Array.isArray(value['entries']) || !value['entries'].every(isHistoryEntry)) {
      rewindLog.warn('history', 'RPC history returned an invalid result')
      return undefined
    }
    const workspace = isRecord(value['workspace']) && typeof value['workspace']['key'] === 'string'
      ? {
          key: value['workspace']['key'],
          ...(typeof value['workspace']['workspaceId'] === 'string' ? { workspaceId: value['workspace']['workspaceId'] } : {}),
          ...(typeof value['workspace']['path'] === 'string' ? { path: value['workspace']['path'] } : {}),
        }
      : { key: '_unknown' }
    return { workspace, entries: value['entries'] }
  } catch (error) {
    rewindLog.warn('history', 'RPC history threw', error)
    return undefined
  }
}

/** Clear the current workspace's rewind history; returns how many were removed. */
export async function clearHistoryOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
): Promise<number | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(CHANNEL, 'history.clear', { sessionId }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      rewindLog.warn('history', 'RPC history.clear failed', result.error)
      return undefined
    }
    const value = result.value
    if (!isRecord(value) || typeof value['cleared'] !== 'number') {
      rewindLog.warn('history', 'RPC history.clear returned an invalid result')
      return undefined
    }
    return value['cleared']
  } catch (error) {
    rewindLog.warn('history', 'RPC history.clear threw', error)
    return undefined
  }
}

/** What the host reports it can do (a missing flag already degraded the UI). */
export interface CapsView {
  readonly history: boolean
  readonly undo: boolean
  readonly fileCheckpointing: boolean
}

/** Read the host's capability report over RPC. */
export async function capsOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
): Promise<CapsView | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(CHANNEL, 'caps', { sessionId }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) return undefined
    const value = result.value
    if (!isRecord(value)) return undefined
    return {
      history: value['history'] === true,
      undo: value['undo'] === true,
      fileCheckpointing: value['fileCheckpointing'] === true,
    }
  } catch (error) {
    rewindLog.warn('history', 'RPC caps threw', error)
    return undefined
  }
}

/** One undo attempt: done, partially done, or refused with a host code. */
export type UndoOutcome =
  | { readonly kind: 'ok' | 'partial'; readonly restored: number; readonly deleted: number }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** Restore files to before one completed rewind (at most once per entry). */
export async function undoOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
  opId: string,
): Promise<UndoOutcome | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(
      CHANNEL,
      'undo',
      { sessionId, opId },
      AbortSignal.timeout(UNDO_TIMEOUT_MS),
    )
    if (!result.ok) {
      return { kind: 'error', code: result.error.code, message: result.error.message }
    }
    const value = result.value
    if (!isRecord(value) || (value['kind'] !== 'ok' && value['kind'] !== 'partial')) {
      return { kind: 'error', code: 'rewind/invalid-response', message: 'invalid undo response' }
    }
    return {
      kind: value['kind'],
      restored: typeof value['restored'] === 'number' ? value['restored'] : 0,
      deleted: typeof value['deleted'] === 'number' ? value['deleted'] : 0,
    }
  } catch (error) {
    rewindLog.warn('history', 'RPC undo threw', error)
    return { kind: 'error', code: 'rewind/undo-failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** One rewind's conversation archive as markdown. */
export interface ArchiveView {
  /** Path relative to the archive root. */
  readonly path: string
  /** The rendered markdown. */
  readonly text: string
}

/** Read one rewind's conversation archive (the folded-away dialogue). */
export async function archiveOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
  opId: string,
): Promise<ArchiveView | undefined> {
  if (connection === undefined) return undefined
  try {
    const result = await connection.rpc.call(CHANNEL, 'archive', { sessionId, opId }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      rewindLog.warn('archive', 'RPC archive failed', result.error)
      return undefined
    }
    const value = result.value
    if (!isRecord(value) || typeof value['path'] !== 'string' || typeof value['text'] !== 'string') {
      rewindLog.warn('archive', 'RPC archive returned an invalid result')
      return undefined
    }
    return { path: value['path'], text: value['text'] }
  } catch (error) {
    rewindLog.warn('archive', 'RPC archive threw', error)
    return undefined
  }
}
