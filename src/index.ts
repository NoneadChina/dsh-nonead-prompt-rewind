/**
 * dsh-rewind host half: the `/rewind` command and the Claude-Code-style
 * checkpoint store, composed as one dual-face bundle row (the browser half
 * lives in `src/client/`).
 *
 * Rewind mechanism: planning is pure (`src/rewind.ts`); execution appends a
 * marker `user/message` whose `surfaceOp` replaces the target and every surface
 * node after it with itself, cutting only the model-visible surface
 * (`docs/architecture.md`).
 *
 * File restore (mode `both`) follows Claude Code's checkpointing: unless
 * `fileCheckpointingEnabled` is off, the plugin backs up each tracked
 * write-class edit BEFORE it happens (at the
 * `tools/execute` around-dispatch stage, so an approval short-circuit cannot
 * skip the capture and a denied call never records), commits the backup under
 * the turn's anchor message seq at `tools/post-execute`, and a rewind to
 * message N restores every backup anchored at or after N — modified files are
 * written back to their pre-edit content, files created after N are deleted.
 * Backups persist on disk under the dsh data directory (newest 100 message
 * groups per session), so restores work after a host restart, and they
 * read/write the real file system with plain `node:fs` — independent of the
 * fs service. See `src/snapshot.ts`.
 *
 * @module dsh-rewind
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { copyFile, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-settings'
import {
  errorText,
  HistoryStore,
  newOpId,
  previewText,
  unknownKey,
  workspaceIdOf,
  workspaceKeyFromRegistry,
  type HistoryOutcome,
  type HistoryWorkspace,
  type WorkspaceLike,
} from './history.ts'
import { readRewindArchive, writeRewindArchive } from './archive-store.ts'
import type { ArchiveEvent } from './archive.ts'
import z from '@deepseek-ai/schemastery'
import { preferredLocale, translate, type HostKey, type HostLocaleId } from './locales.ts'
import { listRewindCandidates, parseRewindTarget, planRewind, REWIND_MARKER_SOURCE, RewindError, type RewindPlan } from './rewind.ts'
import { DEFAULT_MAX_FILE_BYTES, MAX_ANCHOR_GROUPS, reconcileTracked, SnapshotStore, UnknownStoreVersionError, type ClearSessionReport, type FileImpact, type PendingBackup, type PruneStaleReport, type RestoreOutcome, type UncoveredPath } from './snapshot.ts'
import { discoverWorkspaceFiles, DEFAULT_SCAN_MAX_BYTES, DEFAULT_SCAN_MAX_FILES } from './workspace-scan.ts'
import {
  AUTO_SWEEP_INTERVAL_MS,
  DEFAULT_CLEANUP_CONFIG,
  parseCleanupCommand,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveLastSweepAt,
  volatileCleanupStore,
  type CleanupConfig,
  type CleanupConfigStore,
  type CleanupConfigWriter,
  type CleanupSettings,
} from './snapshot-cleanup.ts'

export { SnapshotStore } from './snapshot.ts'
export type { CheckpointEntry, FileImpact, PruneStaleReport, RestoreOutcome, RestoreJournal, RestoreJournalState, RestoreReconcileReport } from './snapshot.ts'

export const name = 'dsh-rewind'
export const inject = ['commands', 'tools', 'settings']

/**
 * The internal engine channel the client drives, so the rewind surface never
 * depends on a name a third-party plugin can take. Mirrored by `ENGINE_COMMAND`
 * in `src/client/hidden.ts` — the two bundles share no module.
 */
export const ENGINE_COMMAND = 'prompt-rewind'

/** The browser RPC channel that replaces the old preview/candidates commands. */
const REWIND_RPC_CHANNEL = '/dsh-rewind'

/** Plugin config. */
export interface RewindConfig {
  /** Checkpoint store root (exact path; beats the harness-home default). */
  readonly snapshotDir?: string
  /** Harness home override (`config.dshHome` > `$DSH_HOME` > `~/.dsh`); feeds the default snapshot/cleanup paths. */
  readonly dshHome?: string
  /** In-place content dedup (identical before-content → link). Default `true`. */
  readonly dedup?: boolean
  /** Per-file backup cap in bytes; `0` disables the cap. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  readonly maxFileBytes?: number
  /** Newest anchor groups (user messages) kept per session. Default {@link MAX_ANCHOR_GROUPS}. */
  readonly maxAnchorGroups?: number
  /** Automatic snapshot-sweep cadence in ms. Default {@link AUTO_SWEEP_INTERVAL_MS}. */
  readonly autoSweepIntervalMs?: number
  /** Rewind-history entries kept PER workspace partition. Default 10. */
  readonly historyLimit?: number
  /** Whether the history entry keeps the target message's text preview. Default true. */
  readonly historyPreview?: boolean
  /**
   * File-count ceiling for the shell-boundary workspace scan. Default
   * {@link DEFAULT_SCAN_MAX_FILES}; `0` falls back to the same default.
   */
  readonly workspaceScanMaxFiles?: number
  /**
   * Byte budget for ONE first-sighting pass. Default
   * {@link DEFAULT_SCAN_MAX_BYTES} (200 MiB); `0` falls back to the same
   * default. A workspace full of media would otherwise copy far more than a
   * checkpoint needs, so the pass stops once the next file would cross it and
   * leaves the rest untracked (a later command sees them again).
   */
  readonly workspaceScanMaxBytes?: number
}

/** The default for {@link FileCheckpointingSettings.fileCheckpointingEnabled}. */
export const DEFAULT_FILE_CHECKPOINTING_ENABLED = true

/**
 * The live file-checkpointing switch (Claude Code's
 * `fileCheckpointingEnabled`): whether NEW before-backups may be recorded.
 */
export interface FileCheckpointingSettings {
  readonly fileCheckpointingEnabled: Volatile<boolean>
}

/** The live rewind-history switch (off ⇒ no entry is written). Optional on the
 * config surface: an absent value keeps the default (on). */
export interface HistorySettings {
  readonly historyEnabled?: Volatile<boolean>
}

/**
 * The live workspace-scan switch: whether a mutating shell command first backs
 * up every workspace file the session has never recorded.
 *
 * Without it, a file that `write`/`edit` never touched (a downloaded script, a
 * generated artefact) has no before-image, so a later shell `rm`/`Remove-Item`
 * can never be rewound — the rewind reports success and leaves the file gone.
 * Absent config keeps the default (on), because the "restore everything"
 * guarantee only holds while the pass runs.
 */
export interface WorkspaceScanSettings {
  readonly workspaceScanEnabled?: Volatile<boolean>
}

/**
 * The plugin's full configuration: store options plus the user-editable policy
 * fields. `.volatile()` resolves them into live references for the Plugins
 * page; the names say what they gate, because a bare `enabled` would read like
 * the entry's own `disabled:` flag.
 */
export interface Config extends RewindConfig, CleanupSettings, FileCheckpointingSettings, HistorySettings, WorkspaceScanSettings {}

/** The `Config` schema the host resolves and projects as this entry's form. */
export const Config = z.object({
  snapshotDir: z.string().required(false),
  dshHome: z.string().required(false),
  dedup: z.boolean().default(true),
  maxFileBytes: z.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
  maxAnchorGroups: z.number().step(1).min(1).default(MAX_ANCHOR_GROUPS),
  autoSweepIntervalMs: z.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS),
  fileCheckpointingEnabled: z.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
  autoCleanupEnabled: z.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),
  historyEnabled: z.boolean().default(true).volatile(),
  historyLimit: z.number().step(1).min(1).max(100).default(10).volatile(),
  historyPreview: z.boolean().default(true).volatile(),
  workspaceScanEnabled: z.boolean().default(true).volatile(),
  workspaceScanMaxFiles: z.number().step(1).min(0).default(DEFAULT_SCAN_MAX_FILES),
  workspaceScanMaxBytes: z.number().step(1).min(0).default(DEFAULT_SCAN_MAX_BYTES),
})

/** Whether new before-backups may be recorded. Absent config keeps the default (on). */
function isFileCheckpointingEnabled(config: Config | undefined): boolean {
  return config?.fileCheckpointingEnabled?.get() !== false
}

/**
 * Whether a shell command first backs up never-recorded workspace files.
 * Absent config keeps the default (on): the guarantee "a rewind restores what
 * the command deleted" only holds while this pass runs.
 */
function isWorkspaceScanEnabled(config: Config | undefined): boolean {
  return config?.workspaceScanEnabled?.get() !== false
}

/**
 * Tool names whose mutations the checkpoint tracker follows.
 *
 * `str_replace_editor` is deliberately ABSENT even though it still exists as an
 * optional DSH package: it stopped being a DEFAULT tool in DSH 0.1.3, and the
 * plugin dropped it with the rest of the dead branches then (see the 0.10.x
 * "adapt to DSH 0.1.3-alpha.2" commit). Do not re-add it here without also
 * deciding to support opt-in deployments of that tool.
 */
const TRACKED_TOOLS = new Set(['write', 'edit'])

/**
 * Tool names whose execution can mutate the workspace outside the write-class
 * capture: a shell can create, rewrite or DELETE any file, including files the
 * tracker has never seen. They are not "tracked tools" (there is no single
 * target path to capture) — instead they trigger the workspace first-sighting
 * pass in {@link captureWorkspaceFirstSightings}.
 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal_send', 'terminal_open', 'run_command'])

/**
 * Whether a session is a subagent child: a direct-delegation session this
 * plugin neither tracks nor rewinds. THE single predicate for every skip site —
 * the checkpoint capture, the message-boundary re-check, the agent-created
 * reconcile, and the lazy cleanup trigger. The Harness refuses every generic
 * Session RPC for such an identity (`session/agent-busy`, "use subagent
 * delivery for this child session"), so a snapshot recorded under a child
 * session id could never be restored by ANY rewind — parent or child — and
 * `/rewind` cannot even execute there. One predicate keeps those facts from
 * drifting apart again (SiriLee/dsh-rewind#26).
 */
function isSubagentSession(session: Session): boolean {
  const header = session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Host-side locale the command output renders in. Refreshed from the durable
 * preference at mount — the command descriptions register once — and again
 * before each command renders (see `readHostLocale`); the neutral default holds
 * until a read succeeds.
 */
let activeLocale: HostLocaleId = 'en'

/** The profile entry dsh-client-locale keeps the browser preference in. */
const LOCALE_ENTRY = 'locale'

/** The preference field inside that entry's form. */
const LOCALE_FIELD = 'preference'

/**
 * Read the user's language preference through the settings service's descriptor
 * read. 0.1.7 keeps that preference in the `locale` entry's own Config rather
 * than in a registered section, and has no host-side locale service, so the
 * descriptor read is the same public route the settings UI and the client's own
 * locale runtime take.
 *
 * `redactSecrets` is requested because the descriptors span every entry. Every
 * failure — a settings service without `describe`, a mount without the locale
 * entry, a throwing read — degrades to the neutral default instead of erroring.
 *
 * @param ctx - context carrying the settings service.
 * @returns the locale this plugin's host copy renders in.
 */
function readHostLocale(ctx: Context): HostLocaleId {
  try {
    const row = ctx.settings.describe({ redactSecrets: true })
      .find(entry => entry.ns === LOCALE_ENTRY)
    return preferredLocale((row?.value as Record<string, unknown> | undefined)?.[LOCALE_FIELD])
  } catch {
    return 'en'
  }
}

/**
 * The cleanup-policy store, mounted from this plugin's resolved config plus the
 * Loader entry that owns it. `undefined` when either is absent (an entry-less
 * mount has nowhere to write), which makes the cleanup command and auto-sweep
 * fail closed (delete nothing) rather than guess.
 */
let cleanupStore: CleanupConfigStore | undefined

/** Render one host dictionary key in the active locale. */
function t(key: HostKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params)
}

/**
 * Report one command name this plugin could not register, without failing the
 * plugin. The host logs stay English, like every other line here.
 * @param ctx - host context carrying the logger.
 * @param name - the command name that could not be registered.
 * @param error - the error the registry raised (usually a duplicate name).
 */
function warnCommandUnavailable(ctx: Context, name: string, error: unknown): void {
  ctx.logger.warn(`[dsh-rewind] command "${name}" was not registered: ${error instanceof Error ? error.message : String(error)}`)
  if (name === ENGINE_COMMAND) {
    ctx.logger.warn(`[dsh-rewind] the internal "${ENGINE_COMMAND}" engine channel is unavailable; rewind execution will not work.`)
  }
}

/** Before-state captured for one in-flight tool call, keyed by agent+callId. */
interface PendingCapture {
  /** Resolved display path (absolute) of the file the call will mutate. */
  readonly path: string
  /** Staged raw before-bytes, or null when the file does not exist (a creation). */
  readonly backup: PendingBackup | null
}

/** Drop a staged capture's bytes (a no-op when nothing was staged). */
async function discardCapture(capture: PendingCapture | undefined): Promise<void> {
  if (capture === undefined || capture.backup === null) return
  try {
    await rm(capture.backup.file, { force: true })
  } catch {
    // The staged copy lives inside the store's own `.pending/`, which `prune`
    // collects when stale; a failed unlink is never worth failing a tool call.
  }
}

/** Extract the file path a tracked tool call mutates, or undefined. */
function mutationPathOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as { file_path?: unknown }
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' ? args.file_path : undefined
  }
  return undefined
}

/** One cached anchor computation for a session. */
interface AnchorCacheEntry {
  /** Anchor seq as of `eventsLength` events. */
  readonly anchor: number | undefined
  /** Number of events the anchor was computed against. */
  readonly eventsLength: number
}

/**
 * Latest `user/message` seq in the session log — the turn's anchor.
 *
 * Incremental: a cached anchor is reused until a NEW user/message lands. Tool
 * and assistant events appended between two tool results move the log tail but
 * never the anchor, so only the events since the last computation are scanned —
 * amortized O(1) per commit instead of a full backward walk every time.
 *
 * Keyed by the Session OBJECT (WeakMap): a session id is a branded string that
 * an exotic lifecycle could reuse, and a stale `eventsLength`-match against a
 * recycled id would hand back another session's anchor.
 */
function anchorSeqOf(session: Session, cache: WeakMap<Session, AnchorCacheEntry>): number | undefined {
  const events = session.snapshotEvents()
  const cached = cache.get(session)
  if (cached !== undefined && cached.eventsLength === events.length) return cached.anchor
  let anchor: number | undefined = cached?.anchor
  for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) {
    if (events[i]!.type === 'user/message') {
      anchor = events[i]!.seq
      break
    }
  }
  cache.set(session, { anchor, eventsLength: events.length })
  return anchor
}

/** Resolve a path against the session's current directory, or undefined on resolution failure. */
async function resolveTarget(
  fs: FileSystem,
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<FileSystem['resolve']>> | undefined> {
  try {
    return await fs.resolve(path, { cwd, signal })
  } catch {
    return undefined
  }
}

/**
 * True when an fs-service error means "the path does not exist". Anything else
 * (an abort, a permission or IO failure, a non-local backend) is NOT an
 * absence: recording it as a creation would let a later `both` rewind DELETE a
 * file that exists.
 */
function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'ENOENT' || code === 'FS_NOT_FOUND'
}

/**
 * Capture the before-state of a tracked mutation during `tools/execute` (the
 * around-dispatch wrapper): the file still holds the old content, and this
 * stage only runs after any pre-execute approval gate allowed the call — so a
 * `{ kind: 'ask' }` short-circuit from another plugin (e.g. dsh-edit-approval)
 * cannot skip the capture, and a denied call never captures (no pending leak).
 * The recorded path is the RESOLVED display path, so restores always name the
 * real file regardless of how the model spelled it.
 *
 * The content is staged as a RAW BYTE COPY (`copyFile` into the store's
 * `.pending/`) — never through a decoded string, so binary and non-UTF-8 files
 * survive the round trip byte-exactly. The fs service provides the path
 * resolution and the `stat` fence (`type !== 'file'` is never copied: a
 * directory, FIFO or device must not be handed to `copyFile`), while the bytes
 * move through plain `node:fs` — the same local-worktree assumption the
 * restore path has always made.
 */
async function captureBefore(
  fs: FileSystem,
  workingDirectory: WorkingDirectoryService,
  store: SnapshotStore,
  exec: ToolExecution,
  pending: Map<string, PendingCapture>,
): Promise<void> {
  if (!TRACKED_TOOLS.has(exec.name)) return
  // No agent Session → no anchor to commit the capture under (see `commitEntry`).
  const agent = exec.agent
  if (agent === undefined) return
  // Claude Code alignment: subagent edits are NOT tracked (official
  // checkpointing limitation). A subagent runs its own session, so a backup
  // recorded under the subagent session id could never be restored by a
  // rewind of the parent session — it would only leak on disk (the subagent
  // log is short, so the per-session 100-group prune never fires for it).
  // Skipping the capture here mirrors Claude Code's behavior exactly.
  if (isSubagentSession(agent.session)) return
  const path = mutationPathOf(exec)
  if (path === undefined) return
  // The fs tools' own base: the Session's current directory (`ensure` also
  // recovers a vanished one).
  const cwd = await workingDirectory.ensure(agent, exec.signal)
  const target = await resolveTarget(fs, path, cwd, exec.signal)
  if (target === undefined) return
  const info = await fs.stat(target, exec.signal).catch((error: unknown) => {
    // Only an affirmative "not found" answer becomes a creation. Any other
    // failure abandons the capture (the caller logs it and the tool proceeds
    // without a backup) — never a "was created" record, which a rewind would
    // turn into a delete of a file that exists.
    if (isNotFoundError(error)) return undefined
    throw error
  })
  // The SERVICE decides whether the file exists. Only `undefined` (no file)
  // records a creation; a non-regular target (directory / FIFO / device) is
  // never copied — it would either hang the copy or produce a meaningless
  // "backup".
  if (info !== undefined && info.type !== 'file') return
  // SIZE CAP: too large to back up, so record NOTHING — never a `before: null`
  // "was created" record, which a rewind would turn into a DELETE of a file
  // that exists. Uses the `size` the stat above already returned (no extra IO)
  // and lands before the staged copy, so a very large file is never read
  // (issue #39). The path is deliberately not registered as tracked: with no
  // record there is no history to contradict, so nothing can be mis-restored.
  if (info !== undefined && store.isOverFileCap(info.size)) return
  const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
  if (info === undefined) {
    pending.set(key, { path: target.displayPath, backup: null })
    return
  }
  const staged = await store.stageCapture(agent.session.id, key)
  let backup: PendingBackup
  try {
    await copyFile(target.displayPath, staged)
    const st = await stat(staged)
    // Permission bits are recorded best-effort next to the bytes: they belong
    // to the file's state, but they never decide whether a restore happens.
    const source = await stat(target.displayPath).catch(() => undefined)
    backup = {
      file: staged,
      size: st.size,
      ...(source !== undefined ? { mode: source.mode & 0o7777 } : {}),
    }
  } catch (error) {
    // The service reported a regular file, so a failed LOCAL copy is NOT "the
    // file does not exist": the display path is not a readable host path (a
    // non-local backend — ADR-11) or the file raced away. Recording a creation
    // here would let a later rewind DELETE that path, so the capture is
    // abandoned instead (the caller logs it) and nothing is staged.
    await rm(staged, { force: true })
    throw error
  }
  pending.set(key, { path: target.displayPath, backup })
}

/**
 * Back up every workspace file the session has never recorded, just before a
 * mutating shell command runs.
 *
 * WHY this exists: the store's original rule is "a file is tracked once a
 * write-class tool handled it". A file produced by a download command, a build,
 * or the user dropping it into the folder has no before-image under that rule,
 * so a later `rm` / `Remove-Item` has nothing to restore — the rewind succeeds
 * but leaves the file gone (observed: `hadFiles: false`, all counters zero).
 * Snapshotting the workspace at the shell boundary closes that hole: from the
 * first command onward, every file that exists is backed up, so its later
 * deletion is rewindable. The ordinary message-boundary re-check then keeps its
 * state current, which is why this pass only has to handle FIRST sightings.
 *
 * Bounded by design: {@link discoverWorkspaceFiles} prunes dependency/build
 * directories, the file cap keeps a huge tree from stalling the tool call, and
 * the store is the single authority on the per-file byte cap (an over-cap file
 * is rejected before it is read). Every failure is per-file: one unreadable
 * path never blocks the command or the rest of the pass.
 */
async function captureWorkspaceFirstSightings(
  workingDirectory: WorkingDirectoryService,
  store: SnapshotStore,
  anchorCache: WeakMap<Session, AnchorCacheEntry>,
  trackedBySession: Map<string, Set<string>>,
  exec: ToolExecution,
  maxFiles: number | undefined,
  maxBytes: number | undefined,
): Promise<Set<string> | undefined> {
  if (!SHELL_TOOLS.has(exec.name)) return undefined
  const agent = exec.agent
  if (agent === undefined) return undefined
  // Subagent sessions own no snapshot a rewind could ever reach (see captureBefore).
  if (isSubagentSession(agent.session)) return undefined
  const anchorSeq = anchorSeqOf(agent.session, anchorCache)
  if (anchorSeq === undefined) return undefined
  const cwd = await workingDirectory.ensure(agent, exec.signal)
  const files = await discoverWorkspaceFiles(
    cwd,
    maxFiles !== undefined && maxFiles > 0 ? { maxFiles } : {},
  )
  if (files.length === 0) return undefined
  const sessionId = agent.session.id
  let tracked = trackedBySession.get(sessionId)
  if (tracked === undefined) {
    tracked = await store.trackedPaths(sessionId)
    trackedBySession.set(sessionId, tracked)
  }
  let index = 0
  const budget = maxBytes !== undefined && maxBytes > 0 ? maxBytes : DEFAULT_SCAN_MAX_BYTES
  let used = 0
  for (const path of files) {
    if (tracked.has(path)) continue
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      // Never stage an over-cap file: the store would reject the entry and the
      // copy would have already paid the whole read.
      if (store.isOverFileCap(info.size)) continue
      // Budget guard: stop BEFORE the copy, so the pass never writes more than
      // the configured ceiling. Remaining files are offered by the next command.
      if (used + info.size > budget) break
      const callId = `scan-${anchorSeq}-${index++}`
      const staged = await store.stageCapture(sessionId, callId)
      try {
        await copyFile(path, staged)
      } catch {
        // Vanished or unreadable between the walk and the copy: drop the staged
        // slice and move on — a guessed record would let a rewind delete a file.
        await rm(staged, { force: true })
        continue
      }
      const st = await stat(staged)
      await store.recordBackup(sessionId, { callId, anchorSeq, path }, { file: staged, size: st.size })
      used += st.size
      // Tracked from now on: the message-boundary re-check keeps it current, so
      // this pass never has to copy the same bytes twice.
      tracked.add(path)
    } catch {
      // Per-file failure (permission, IO, refused store): skip this path only.
    }
  }
  // Hand back the files that existed BEFORE the command ran: the post-execute
  // pass diffs this set against the tree to find what the command removed.
  return new Set(files)
}

/**
 * Re-anchor every file the shell command just DELETED at the deleting turn.
 *
 * WHY: a deletion happens inside a turn that has no write-before capture of
 * its own (the command is not a `write`/`edit`), so that turn ends up with no
 * entry saying "the file existed when I started". A rewind to it then finds
 * nothing to plan and reports success while the file stays gone — the exact
 * report this pass exists to fix. The bytes the file had right before the
 * command are still in the store (the workspace first-sighting pass or an
 * earlier write backup), so recording that same blob again at THIS anchor gives
 * the turn its "existed at the start" entry.
 *
 * Only paths that actually disappeared are touched, so a command that deletes
 * nothing costs one comparison and no IO.
 */
async function captureWorkspaceDeletions(
  workingDirectory: WorkingDirectoryService,
  store: SnapshotStore,
  anchorCache: WeakMap<Session, AnchorCacheEntry>,
  exec: ToolExecution,
  before: ReadonlySet<string>,
  maxFiles: number | undefined,
): Promise<void> {
  if (before.size === 0) return
  const agent = exec.agent
  if (agent === undefined) return
  if (isSubagentSession(agent.session)) return
  const anchorSeq = anchorSeqOf(agent.session, anchorCache)
  if (anchorSeq === undefined) return
  const cwd = await workingDirectory.ensure(agent, exec.signal)
  const after = new Set(await discoverWorkspaceFiles(
    cwd,
    maxFiles !== undefined && maxFiles > 0 ? { maxFiles } : {},
  ))
  const sessionId = agent.session.id
  let index = 0
  for (const path of before) {
    if (after.has(path)) continue
    try {
      // The newest CONTENT record from an anchor earlier than this turn: the
      // state the file was in when the command started.
      const previous = await store.latestContentBlob(sessionId, path, anchorSeq)
      if (previous === undefined) continue
      const callId = `del-${anchorSeq}-${index++}-${Date.now().toString(36)}`
      const staged = await store.stageCapture(sessionId, callId)
      try {
        await copyFile(previous.file, staged)
      } catch {
        // Blob unreadable / pruned: drop the slice, never guess a record.
        await rm(staged, { force: true })
        continue
      }
      const st = await stat(staged)
      await store.recordBackup(sessionId, { callId, anchorSeq, path }, { file: staged, size: st.size })
    } catch {
      // Per-file failure: skip this path only, never abort the pass.
    }
  }
}

/**
 * Commit one tracked mutation during `tools/post-execute`: resolve the turn
 * anchor and MOVE the staged before-bytes into the checkpoint store. Failed
 * calls never commit (the staged capture is dropped); a capture staged before
 * the checkpointing switch flipped off is dropped here too.
 */
async function commitEntry(
  store: SnapshotStore,
  pending: Map<string, PendingCapture>,
  anchorCache: WeakMap<Session, AnchorCacheEntry>,
  trackedBySession: Map<string, Set<string>>,
  exec: ToolExecution,
  result: ToolExecutionResult,
  checkpointingEnabled: boolean,
): Promise<void> {
  const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
  const capture = pending.get(key)
  if (capture === undefined) return
  pending.delete(key)
  // A flip between capture and commit drops the staged bytes.
  if (!checkpointingEnabled) {
    await discardCapture(capture)
    return
  }
  if (result.isError) {
    await discardCapture(capture)
    return
  }
  const agent = exec.agent
  if (agent === undefined) {
    await discardCapture(capture)
    return
  }
  const anchorSeq = anchorSeqOf(agent.session, anchorCache)
  if (anchorSeq === undefined) {
    await discardCapture(capture)
    return
  }
  try {
    await store.recordBackup(agent.session.id, {
      callId: exec.callId,
      anchorSeq,
      path: capture.path,
    }, capture.backup)
  } catch (error) {
    // A refused commit (a store written by a newer build, an IO failure) leaves
    // the staged bytes with no owner: the capture already left `pending` above,
    // so the `tools/result` net cannot reach them, and `.pending/` is collected
    // only from a LATER successful commit of the same session — which a refused
    // store never reaches. Drop them here and keep the failure loud.
    await discardCapture(capture)
    throw error
  }
  // The path is now a tracked file: remember it for the boundary re-check
  // (the per-session set may not have been loaded yet — seed it lazily).
  let tracked = trackedBySession.get(agent.session.id)
  if (tracked === undefined) {
    tracked = new Set()
    trackedBySession.set(agent.session.id, tracked)
  }
  tracked.add(capture.path)
}

/**
 * The rewind-marker content, always this minimal self-declaring placeholder.
 *
 * It must be provider-independent. The session log is append-only (the marker
 * content is frozen when written), but the model serving a session may change
 * later — so a conditional empty content would break the moment a strict
 * OpenAI-compatible gateway is used after a rewind (HTTP 400 "user message
 * must have content", Issue #21). A constant non-empty placeholder is accepted
 * by every gate and reads as an empty one the model need not act on.
 */
const REWIND_MARKER_CONTENT: ContentBlock[] = [{ type: 'text', text: '(empty message)' }]

/**
 * Build the rewind marker: a `user/message` carrying the surface-replace op.
 * Surface `replace` belongs to the node that cites the shadowed seqs via
 * `sourceEventSeqs`, and `user/message` is the only surface type that can do so
 * (the source is the producer-owned `{ kind: 'dsh-rewind' }`, see `marker.ts`).
 * It is appended while idle, outside any turn — `docs/architecture.md` records
 * why that needs no step frame.
 */
function buildMarker(): UserMessage {
  return createUserMessage({
    content: REWIND_MARKER_CONTENT,
    source: REWIND_MARKER_SOURCE,
  })
}

/** Human-readable size for the report lines (binary units, whole numbers). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** Resolve a raw target token into a plan, mapping failures to messages. */
function resolveOrError(events: readonly SessionEvent[], surface: readonly number[], raw: string): RewindPlan {
  const target = parseRewindTarget(raw)
  if (target === undefined) {
    throw new RewindError('invalid-index', t('error.invalidTarget', { raw }))
  }
  return planRewind(events, surface, target)
}

/** The file impact of a rewind target, served over the RPC channel. */
interface PreviewImpact {
  readonly files: readonly FileImpact[]
  /** Recorded paths whose current size is over the backup cap. */
  readonly uncovered: readonly UncoveredPath[]
  /** New snapshots are disabled; the restore may be incomplete. */
  readonly backupOff: boolean
}

/** Compute one target's file impact against the current disk. */
async function previewImpact(
  store: SnapshotStore,
  session: Session,
  seq: number,
  checkpointingEnabled: boolean,
): Promise<PreviewImpact> {
  const plan = resolveOrError(session.snapshotEvents(), session.surface.nodes, `@${seq}`)
  let impacts: readonly FileImpact[]
  try {
    impacts = await store.impactsAfter(session.id, plan.targetSeq)
  } catch (error) {
    if (!(error instanceof UnknownStoreVersionError)) throw error
    throw new Error(t('storeUnsupported', { version: await store.readStoreVersion(session.id) ?? 0 }))
  }
  const uncovered = await store.uncoveredPaths(session.id).catch(() => [] as UncoveredPath[])
  return { files: impacts, uncovered, backupOff: !checkpointingEnabled }
}

/** Result envelope of one rewind RPC endpoint. */
type RewindRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Handler shape of the Host Connection generic RPC registry. */
type RewindRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<RewindRpcResult>

/** The slice of `ctx.connection` this plugin registers on. */
interface RewindRpcHost {
  readonly rpc: { handle(channel: string, handler: RewindRpcHandler): () => Promise<void> }
}

/**
 * `Symbol.for('cordis.isolate')`: every cordis context carries this symbol-keyed
 * table mapping service names to their isolation keys.
 */
const CORDIS_ISOLATE = Symbol.for('cordis.isolate')

/**
 * Read a service's RAW implementation out of a cordis context.
 *
 * A context proxy hands back a traced wrapper (so method calls see the caller's
 * active context), and its prototype is the service CLASS, not the instance —
 * deriving from it would drop every field the constructor assigned. The
 * implementation itself is reachable through the reflection store, keyed by the
 * service's isolation symbol.
 *
 * @param base - the context to read from.
 * @param name - the service name.
 * @returns the raw implementation, or undefined when it cannot be located.
 */
export function rawServiceOf(base: object, name: string): unknown {
  const isolate = (base as unknown as Record<symbol, Record<string, symbol> | undefined>)[CORDIS_ISOLATE]
  const key = isolate?.[name]
  if (key === undefined) return undefined
  try {
    // `reflect` is a core context accessor rather than a registered service, so it
    // is read as a property (the reflected store is public).
    const reflect = (base as {
      readonly reflect?: { readonly store?: Readonly<Record<symbol, { readonly value?: unknown }>> }
    }).reflect
    return reflect?.store?.[key]?.value
  } catch {
    return undefined
  }
}

/**
 * Re-derive a RAW service instance so that the lookups it performs INSIDE
 * `rpc.handle` resolve from the application root instead of the provider's own
 * context.
 *
 * Why this exists: `rpc.handle(channel, handler)` stores the channel through
 * `owner.effect(() => owner.webServer.register(route), ...)`, where `owner` is
 * the Connection service's own *define-site* context. `webServer` and
 * `connection` are provided by two DIFFERENT plugin fibres, so that read walks
 * the provider's fibre chain, dead-ends at the root fibre (`runtime === null`)
 * and throws `cannot get property "webServer" without inject` — the channel is
 * then never registered and every client query degrades to "host RPC is
 * unavailable" (Settings → Rewind history shows exactly that).
 *
 * A thin inheriting object with `ctx` redefined to the root keeps every method
 * and constructor field unchanged; only the define-site of the service's own
 * lookups moves, and the root context resolves `webServer` through its
 * unchecked path.
 *
 * @param raw - the raw service implementation (see {@link rawServiceOf}).
 * @param root - the application root context.
 * @returns the re-based service, or undefined when the shape is not as expected
 *   (the caller then falls back to the plain service and reports the failure).
 */
export function rebaseOnRoot<T extends object>(raw: T, root: object): T | undefined {
  if (typeof (raw as { readonly rpc?: { readonly handle?: unknown } }).rpc?.handle !== 'function') return undefined
  const bridge = Object.create(raw) as T
  // The service's own accessor reads `this.ctx`; redefine it here so the read
  // lands on the root context rather than on the provider's fibre.
  Object.defineProperty(bridge, 'ctx', { value: root, configurable: true, writable: true })
  return bridge
}

/** The slice of `ctx.agents` the RPC handler resolves a session through. */
interface AgentLookup {
  get(sessionId: SessionId): { readonly session: Session } | undefined
}

/** True for a plain object payload. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build one failed RPC result. */
function rpcFailure(code: string, message: string): RewindRpcResult {
  return { ok: false, error: { code, message, details: {} } }
}

/** Serve the impact preview, the candidate list, and the rewind history over Connection RPC. */
function createRewindRpcHandler(
  store: SnapshotStore,
  agentsOf: () => AgentLookup | undefined,
  checkpointingEnabled: () => boolean,
  historyOf: () => HistoryHost | undefined,
  workspaceOf: (session: Session) => HistoryWorkspace,
): RewindRpcHandler {
  return async (endpoint, payload) => {
    try {
      if (!isRecord(payload)) return rpcFailure('rewind/bad-request', 'invalid payload')
      const sessionId = payload['sessionId']
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return rpcFailure('rewind/bad-request', 'sessionId must be a non-empty string')
      }
      const agents = agentsOf()
      if (agents === undefined) return rpcFailure('rewind/agents-unavailable', 'agent registry is unavailable')
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return rpcFailure('rewind/session-not-found', `session ${sessionId} is not attached`)
      const session = agent.session
      if (endpoint === 'preview') {
        const seq = payload['seq']
        if (!Number.isSafeInteger(seq)) return rpcFailure('rewind/bad-request', 'seq must be an integer')
        return { ok: true, value: await previewImpact(store, session, seq as number, checkpointingEnabled()) }
      }
      if (endpoint === 'candidates') {
        return {
          ok: true,
          value: { candidates: listRewindCandidates(session.snapshotEvents(), session.surface.nodes) },
        }
      }
      // What THIS host actually provides. The client degrades a missing surface
      // already; reporting it lets the settings page say so instead of hiding
      // the loss (§8.3 of the development guide).
      if (endpoint === 'caps') {
        const hasHistory = historyOf() !== undefined
        return {
          ok: true,
          value: {
            history: hasHistory,
            undo: hasHistory,
            fileCheckpointing: checkpointingEnabled(),
          },
        }
      }
      // History is partitioned by WORKSPACE, derived from the session — the
      // client never supplies a partition key (§6.1 of the development guide).
      if (endpoint === 'history') {
        const host = historyOf()
        if (host === undefined) return { ok: true, value: { entries: [] } }
        const workspace = workspaceOf(session)
        return {
          ok: true,
          value: { workspace, entries: await host.store.list(workspace.key) },
        }
      }
      if (endpoint === 'history.clear') {
        const host = historyOf()
        if (host === undefined) return { ok: true, value: { cleared: 0 } }
        return { ok: true, value: { cleared: await host.store.clear(workspaceOf(session).key) } }
      }
      // Undo one completed rewind: files only (the conversation cannot be
      // resurrected — `foldSurface` removed those nodes), at most once per
      // entry, and only for the chain tail (§6.3).
      if (endpoint === 'undo') {
        const host = historyOf()
        if (host === undefined) return rpcFailure('rewind/not-undoable', 'history is unavailable')
        const opId = payload['opId']
        if (typeof opId !== 'string' || opId.length === 0) {
          return rpcFailure('rewind/bad-request', 'opId must be a non-empty string')
        }
        const workspace = workspaceOf(session)
        const entries = await host.store.list(workspace.key)
        const entry = entries.find(candidate => candidate.opId === opId)
        if (entry === undefined) return rpcFailure('rewind/unknown-entry', `history entry ${opId} is not in this workspace`)
        if (entry.workspaceKey !== workspace.key) return rpcFailure('rewind/undo-cross-workspace', 'entry belongs to another workspace')
        // The page only offers the active session's chain tail; refuse another
        // session's entry at the channel too, so a hand-made call cannot undo a
        // rewind the user is not looking at.
        if (entry.sessionId !== session.id) return rpcFailure('rewind/undo-other-session', 'entry belongs to another session')
        if (entry.undoneAt !== undefined) return rpcFailure('rewind/already-undone', 'this rewind was already restored once')
        if (!entry.undoable) return rpcFailure('rewind/not-undoable', 'the snapshot for this rewind is gone')
        if (!HistoryStore.isChainTail(entries, entry)) {
          return rpcFailure('rewind/undo-not-top', 'restore the newer rewind first')
        }
        try {
          const outcome = await store.undoRestore(entry.sessionId, opId, path => unlink(path))
          await host.store.patch(workspace.key, opId, {
            undoneAt: Date.now(),
            undoOutcome: outcome.failed.length > 0 ? 'partial' : 'success',
            undoMode: 'files',
          })
          return {
            ok: true,
            value: {
              kind: outcome.failed.length > 0 ? 'partial' : 'ok',
              restored: outcome.restored.length,
              deleted: outcome.deleted.length,
              failed: outcome.failed,
            },
          }
        } catch (error) {
          const code = (error as { code?: string }).code === 'stale-undo'
            ? 'rewind/stale-undo'
            : 'rewind/undo-failed'
          const stalePaths = (error as { stalePaths?: readonly string[] }).stalePaths
          return rpcFailure(
            code,
            `${error instanceof Error ? error.message : String(error)}${stalePaths === undefined ? '' : ` [${stalePaths.join(', ')}]`}`,
          )
        }
      }
      // Read one rewind's conversation archive (markdown rendered at rewind
      // time). This is the only way back to the folded content: the surface
      // cannot be unfolded, so the archive is the recovery path (§6.4).
      if (endpoint === 'archive') {
        const host = historyOf()
        if (host === undefined) return rpcFailure('rewind/no-archive', 'history is unavailable')
        const opId = payload['opId']
        if (typeof opId !== 'string' || opId.length === 0) {
          return rpcFailure('rewind/bad-request', 'opId must be a non-empty string')
        }
        const workspace = workspaceOf(session)
        const entries = await host.store.list(workspace.key)
        const entry = entries.find(candidate => candidate.opId === opId)
        if (entry === undefined) return rpcFailure('rewind/unknown-entry', `history entry ${opId} is not in this workspace`)
        if (entry.sessionId !== session.id) return rpcFailure('rewind/undo-other-session', 'entry belongs to another session')
        if (entry.archivePath === undefined) return rpcFailure('rewind/no-archive', 'this rewind has no conversation archive')
        const text = await readRewindArchive(host.archiveRoot, entry.archivePath)
        if (text === undefined) return rpcFailure('rewind/archive-missing', `archive ${entry.archivePath} is unreadable`)
        return { ok: true, value: { path: entry.archivePath, text } }
      }
      return rpcFailure('rewind/unknown-endpoint', `unknown endpoint: ${endpoint}`)
    } catch (error) {
      return rpcFailure('rewind/failed', error instanceof Error ? error.message : String(error))
    }
  }
}

/** One failed file restore, rendered for the result text. */
function renderFailures(failed: readonly { path: string; message: string }[]): string {
  if (failed.length === 0) return ''
  return t('failures.suffix', {
    count: failed.length,
    list: failed.map(f => t('failures.item', { path: f.path, message: f.message })).join(t('sep.list')),
  })
}

/**
 * One "not restored" line per skipped path the cap caused: a path that is both
 * in the uncovered set (current size over the cap) and skipped by this pass is
 * exactly the cap refusal. Other skips stay summarised by `skip.count`.
 */
function renderSkipped(outcome: RestoreOutcome, uncovered: readonly UncoveredPath[], maxFileBytes: number): string {
  const capped = new Set(uncovered.map(item => item.path))
  const limit = formatBytes(maxFileBytes)
  return outcome.skipped
    .filter(path => capped.has(path))
    .map(path => t('plan.skip', { path, reason: t('skipReason.oversized', { limit }) }))
    .join('\n')
}

/**
 * Resolve a restored/deleted display path back into an fs target, or
 * undefined on resolution failure (the sync then skips the file silently).
 */
async function resolveObservationTarget(
  fs: FileSystem,
  path: string,
): Promise<Awaited<ReturnType<FileSystem['resolve']>> | undefined> {
  try {
    return await fs.resolve(path)
  } catch {
    return undefined
  }
}

/**
 * Re-sync the harness fs-observation-policy's per-session observation cache
 * after a both-mode restore. The restore writes/deletes through plain
 * `node:fs`, which the policy layer cannot see — that is about the
 * observation cache, not permission enforcement (the restore still touches
 * only the `planRestore` path set). Without this sync, the same
 * session's next write of a restored or rewind-deleted file is judged against
 * the STALE pre-restore observation (the file still "present" at its old
 * version), so the write tool's intent becomes `replaceIfVersion` and
 * `fs-local` refuses the now-missing file with `FS_STALE_VERSION` ("file no
 * longer exists — re-read the file, then retry") — even though the agent is
 * legitimately creating a fresh file after the rewind.
 *
 * Emitting authoritative observations on the same public `fs/observed` event
 * the read/write tools emit tells the policy layer the truth it cannot learn
 * otherwise: deleted files become `{ kind: 'absent' }` (next write uses
 * `createIfAbsent`); restored files become `{ kind: 'present', version }`
 * from a fresh stat (next write CASes against the current version and
 * succeeds). The safety model is unchanged: a LATER external modification
 * after this sync still trips the stale guard exactly as before — only the
 * inconsistency CREATED BY THE RESTORE ITSELF is healed.
 *
 * Per-file failures are silent no-ops: without fs, or when resolve/stat
 * fails, the pre-existing behavior (the write tool's remediated stale error
 * with its re-read hint) remains the fallback.
 *
 * @param ctx - context carrying the `fs/observed` event bus.
 * @param fs - the fs service, or undefined when the deployment has none.
 * @param agent - the rewound agent; its session is the observation owner.
 * @param outcome - the restore outcome (deleted/restored paths to sync).
 */
async function syncRestoreObservations(
  ctx: Context,
  fs: FileSystem | undefined,
  agent: Agent,
  outcome: RestoreOutcome,
): Promise<void> {
  if (fs === undefined) return
  const actor = { agent }
  for (const path of outcome.deleted) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'absent' }, actor)
  }
  for (const path of outcome.restored) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    const info = await fs.stat(target).catch(() => undefined)
    if (info === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
  }
}

/**
 * Wait until an agent reaches `idle` (a running turn stops), or the
 * deadline/abort hits. Uses the agent's own `whenIdle()` — the loop's
 * activity promise — instead of polling `status` every 50ms. The agent's
 * status reads `idle` during a `maintenance` phase too, so we ALWAYS race
 * `whenIdle()` (which follows the activity promise, maintenance included)
 * rather than short-circuiting on the status: its concurrent session writes
 * would otherwise race the rewind's append.
 */
async function waitForAgentIdle(agent: Agent, signal: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  if (signal.aborted) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rewind idle wait timed out')), timeoutMs)
        onAbort = () => reject(new Error('rewind idle wait aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Sessions with a rewind currently executing (per-session in-flight guard). */
type InflightRewinds = Set<string>

/**
 * Drop every pending steering (next-step) inbox message. Used when a rewind
 * rolls the conversation back to a point before them: they belong to the
 * future being cut, and keeping them would deliver them first on the next
 * send. Queued (next-turn) messages are deliberately NOT touched — the
 * harness QueueDock already offers the user per-item edit/remove.
 */
function dropPendingSteering(agent: Agent): void {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id)
  }
}

/** Everything one command path needs to append a history entry. */
export interface HistorySink {
  readonly store: HistoryStore
  readonly workspace: HistoryWorkspace
  readonly preview: boolean
  /** Snapshot of the live switch at command time. */
  readonly enabled: boolean
}

/**
 * The mount-level history surface: one store for the whole plugin lifetime.
 * The partition is resolved per session (see {@link historyWorkspaceOf}), so
 * this does not carry a workspace.
 */
export interface HistoryHost {
  readonly store: HistoryStore
  readonly preview: boolean
  /** Where conversation archives live (sibling of the history root). */
  readonly archiveRoot: string
  /** Live switch: false ⇒ no entry is written (a volatile config read). */
  readonly enabled: () => boolean
}

/** What the rewind path knows when the entry is written. */
interface HistoryDraft {
  readonly targetSeq: number
  readonly outcome: HistoryOutcome
  readonly hadFiles: boolean
  readonly shadowed?: number
  readonly attachments?: number
  readonly preview?: string
  readonly files?: {
    readonly restored: number
    readonly deleted: number
    readonly skipped: number
    readonly uncovered: number
    readonly preview: readonly string[]
  }
  readonly errorCode?: string
  readonly errorText?: string
  readonly undoable?: boolean
  /** Relative archive path of the folded conversation, when one was written. */
  readonly archivePath?: string
  /** The journal's id when the caller already minted one (success path). */
  readonly opId?: string
  /** Fixed timestamp so the entry and the journal agree on "when". */
  readonly at?: number
}

/** `targetSeq` marker for a failure that never got as far as planning. */
export const HISTORY_UNRESOLVED_SEQ = -1

/**
 * Resolve the history partition for one session. The Session object carries no
 * `workspaceId` on 0.2.2-alpha.2, so ownership is a reverse lookup over
 * `WorkspaceView.sessionIds`. A session the registry does not account for lands
 * in the shared `_unknown` partition: without a trustworthy cwd on the Session,
 * inventing a path-derived key from a guess would mis-file the entry.
 */
export function historyWorkspaceOf(ctx: Context, session: Session): HistoryWorkspace {
  const registry = (ctx as unknown as { get?(name: string): unknown }).get?.('workspaceRegistry') as
    | { list(): readonly WorkspaceLike[] }
    | undefined
  let workspaces: readonly WorkspaceLike[] | undefined
  try {
    workspaces = registry?.list()
  } catch {
    workspaces = undefined
  }
  const hit = workspaceKeyFromRegistry(session.id, workspaces)
  if (hit === undefined) return { key: unknownKey() }
  // The registry serves ENTITIES whose identifier is `id`; `workspaceId` is the
  // RPC `WorkspaceView` spelling. Read both, and omit the field entirely when
  // neither is present so a stored partition never carries `undefined`.
  const workspaceId = workspaceIdOf(hit.workspace)
  return {
    key: hit.key,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(hit.workspace.path !== undefined ? { path: hit.workspace.path } : {}),
  }
}

/**
 * Append one history entry.
 *
 * Runs to completion before the command returns: the write is a few KB with an
 * atomic rename, and awaiting it removes a real race — a client that reads the
 * history right after a rewind would otherwise miss the entry it just created.
 * It still never throws and never alters the rewind result.
 */
export async function recordHistoryEntry(
  sink: HistorySink | undefined,
  session: Session,
  draft: HistoryDraft,
): Promise<void> {
  if (sink === undefined || !sink.enabled) return
  try {
    const at = draft.at ?? Date.now()
    const entries = await sink.store.list(sink.workspace.key)
    const chainPrev = HistoryStore.previousOf(entries, session.id)
    await sink.store.append({
      opId: draft.opId ?? newOpId(at),
      workspaceKey: sink.workspace.key,
      ...(sink.workspace.workspaceId !== undefined ? { workspaceId: sink.workspace.workspaceId } : {}),
      sessionId: session.id,
      at,
      targetSeq: draft.targetSeq,
      hadFiles: draft.hadFiles,
      outcome: draft.outcome,
      shadowedEvents: draft.shadowed ?? 0,
      messagePreview: previewText(draft.preview ?? '', sink.preview),
      attachments: draft.attachments ?? 0,
      ...(draft.files !== undefined ? { files: draft.files } : {}),
      ...(draft.errorCode !== undefined ? { errorCode: draft.errorCode } : {}),
      ...(draft.errorText !== undefined ? { errorText: errorText(draft.errorText) } : {}),
      ...(chainPrev !== undefined ? { chainPrev } : {}),
      ...(draft.archivePath !== undefined ? { archivePath: draft.archivePath } : {}),
      undoable: draft.undoable ?? draft.hadFiles,
    })
  } catch {
    // History is an audit trail; losing one line must never surface as a
    // rewind failure. The store warns on its own failures.
  }
}

/** The target message's text, for the history preview (never throws). */
export function previewOfTarget(session: Session, seq: number): string {
  try {
    const event = session.snapshotEvents()[seq]
    const content = (event?.data as { content?: readonly { type: string; text?: string }[] } | undefined)?.content
    if (content === undefined) return ''
    return content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join(' ')
  } catch {
    return ''
  }
}

/** Execute a validated rewind: append the marker, then optionally restore files. */
async function executeRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  rawTarget: string,
  inflight: InflightRewinds,
  checkpointingEnabled: boolean,
  history?: HistoryHost,
): Promise<CommandResult> {
  const { agent } = invocation
  // The partition belongs to the SESSION, so it is resolved here rather than
  // at mount time (one mount serves every session in the window).
  const sink: HistorySink | undefined = history === undefined
    ? undefined
    : {
        store: history.store,
        workspace: historyWorkspaceOf(ctx, agent.session),
        preview: history.preview,
        enabled: history.enabled(),
      }  /** Best-effort target for early failures, which never reach `planRewind`. */
  const unresolvedSeq = (): number => {
    const target = parseRewindTarget(rawTarget)
    return target?.kind === 'seq' ? target.seq : HISTORY_UNRESOLVED_SEQ
  }
  const sessionId = agent.session.id
  // Per-session in-flight guard: two concurrent rewinds (double-click, a
  // second tab) would both plan against the same surface; the second append's
  // replace range would then target nodes the first marker already shadowed,
  // and `Session.append` rejects with "start seq not found in surface".
  if (inflight.has(sessionId)) {
    await recordHistoryEntry(sink, agent.session, {
      targetSeq: unresolvedSeq(),
      outcome: 'failed',
      hadFiles: false,
      errorCode: 'inflight',
      errorText: t('inflight'),
    })
    return { kind: 'error', text: t('inflight') }
  }
  inflight.add(sessionId)
  try {
    // A running turn (the LLM is thinking or streaming) must be stopped before
    // the surface can be cut: force-cancel it (user cause), wait for quiescence,
    // then rewind. The inbox is KEPT by the cancel (keepInbox) — only the
    // pending steering (next-step) messages are dropped below: they belong to
    // the future being rolled back. Queued (next-turn) messages are left
    // untouched: the harness QueueDock already offers per-item edit/remove, so
    // a rewind must not silently drop messages the user may still want to send.
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        await recordHistoryEntry(sink, agent.session, {
          targetSeq: unresolvedSeq(),
          outcome: 'failed',
          hadFiles: false,
          errorCode: 'stop-failed',
          errorText: t('stopFailed'),
        })
        return { kind: 'error', text: t('stopFailed') }
      }
    }
    // Idle or not, rewinding to a point before them must not keep pending
    // steering messages alive to be delivered first on the next send.
    dropPendingSteering(agent)
    // The command was cancelled (or its caller aborted) while we waited for
    // quiescence: stop here instead of executing a rewind nobody asked for.
    if (invocation.signal.aborted) {
      await recordHistoryEntry(sink, agent.session, {
        targetSeq: unresolvedSeq(),
        outcome: 'failed',
        hadFiles: false,
        errorCode: 'cancelled',
        errorText: t('cancelled'),
      })
      return { kind: 'error', text: t('cancelled') }
    }
    let plan: RewindPlan
    try {
      plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget)
    } catch (error) {
      return rewindErrorResult(error)
    }

    const marker = buildMarker()
    let event: ReturnType<Session['append']>
    try {
      event = agent.session.append('user/message', marker, {
        surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
        sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
      })
    } catch (error) {
      const text = t('failed', { error: error instanceof Error ? error.message : String(error) })
      await recordHistoryEntry(sink, agent.session, {
        targetSeq: unresolvedSeq(),
        outcome: 'failed',
        hadFiles: false,
        errorCode: 'append-failed',
        errorText: text,
      })
      return { kind: 'error', text }
    }

    // A rewind cuts only the model-visible surface and never touches the
    // log-only `plan/mode` events — plan mode is a separate state the plugin
    // does not manage. `/plan text` is two independent actions (enter plan
    // mode + steer the message); rewinding the message undoes only the
    // message, leaving plan mode for the user to leave with `/plan off`.

    let restore = ''
    /** The restore pass's outcome, kept for the history entry. */
    let restoreOutcome: RestoreOutcome | undefined
    // One id for both the journal and the history entry, so the undo path can
    // address the journal from the entry it rendered (§6.3).
    const historyAt = Date.now()
    const historyOpId = newOpId(historyAt)
    // The conversation and the workspace files always rewind together —
    // there is no mode selection (docs/DEVELOPMENT-GUIDE.zh.md §4.1).
    {
      // The restore touches the real worktree through raw node:fs (unlink /
      // writeFile), not the fs service, because it must also reach paths the
      // service would refuse as stale/absent. That is safe only because the
      // action set is the closed `planRestore`-derived one: paths the session
      // recorded, no symlink/hard link, differing from the disk.
      let outcome: RestoreOutcome | undefined
      try {
        outcome = await store.restoreAfter(
          agent.session.id,
          plan.targetSeq,
          path => unlink(path),
          undefined,
          { opId: historyOpId },
        )
        restoreOutcome = outcome
      } catch (error) {
        // Snapshots written by a newer build: fail the FILE RESTORE closed
        // (nothing was changed) while the conversation rewind above already
        // succeeded — the two are independent.
        if (!(error instanceof UnknownStoreVersionError)) throw error
        const version = await store.readStoreVersion(agent.session.id)
        restore = `${t('sep.clause')}${t('storeUnsupported', { version: version ?? error.version })}`
      }
      if (outcome !== undefined) {
        // The restore wrote through plain node:fs, invisible to the harness
        // observation policy: re-sync it so the session's next write of a
        // restored/deleted file is not judged against the stale pre-restore
        // observation (see syncRestoreObservations).
        await syncRestoreObservations(ctx, fs, agent, outcome)
        const parts: string[] = []
        if (outcome.restored.length > 0) parts.push(t('restore.count', { count: outcome.restored.length }))
        if (outcome.deleted.length > 0) parts.push(t('delete.count', { count: outcome.deleted.length }))
        if (outcome.skipped.length > 0) {
          parts.push(t('skip.count', { count: outcome.skipped.length }))
          // Name the cap refusals: the conservative choice (leave a file alone)
          // must still be visible, never a silent omission.
          const capped = await store.uncoveredPaths(agent.session.id).catch(() => [] as UncoveredPath[])
          const skippedLines = renderSkipped(outcome, capped, store.fileCapBytes)
          if (skippedLines !== '') parts.push(skippedLines)
        }
        if (!checkpointingEnabled) parts.push(t('backupOff'))
        restore = parts.length > 0 ? `${t('sep.clause')}${parts.join(t('sep.list'))}` : t('noRestorable')
        restore += renderFailures(outcome.failed)
      }
    }

    // Every rewind withdraws the target message and everything after it; its
    // content is offered back in the composer for re-sending.
    const hadFileWork = restoreOutcome !== undefined
      && restoreOutcome.restored.length + restoreOutcome.deleted.length + restoreOutcome.skipped.length > 0
    // Archive the folded-away conversation BEFORE the entry is written, so the
    // entry can point at it. Best-effort: losing the archive must never turn a
    // successful rewind into an error (same contract as the history entry).
    // The session log is append-only, so these events are still readable here
    // even though the marker is about to remove them from the surface.
    const archivePath = history === undefined
      ? undefined
      : (await writeRewindArchive(history.archiveRoot, {
          sessionId: agent.session.id,
          opId: historyOpId,
          targetSeq: plan.targetSeq,
          at: historyAt,
          events: agent.session.snapshotEvents() as unknown as ArchiveEvent[],
          shadowedSeqs: plan.shadowedSeqs,
        }))?.relativePath
    await recordHistoryEntry(sink, agent.session, {
      targetSeq: plan.targetSeq,
      at: historyAt,
      opId: historyOpId,
      ...(archivePath !== undefined ? { archivePath } : {}),
      outcome: restoreOutcome !== undefined && (restoreOutcome.failed.length > 0 || restoreOutcome.skipped.length > 0)
        ? 'partial'
        : 'success',
      hadFiles: hadFileWork,
      shadowed: plan.shadowedSeqs.length,
      preview: previewOfTarget(agent.session, plan.targetSeq),
      ...(restoreOutcome === undefined
        ? {}
        : {
            files: {
              restored: restoreOutcome.restored.length,
              deleted: restoreOutcome.deleted.length,
              skipped: restoreOutcome.skipped.length,
              uncovered: 0,
              preview: [...restoreOutcome.restored, ...restoreOutcome.deleted, ...restoreOutcome.skipped].slice(0, 20),
            },
          }),
    })
    return {
      kind: 'success',
      text: t('success', { targetSeq: plan.targetSeq, restore }),
      sourceEventSeq: event.seq,
    }
  } finally {
    inflight.delete(sessionId)
  }
}

/** Map a typed rewind failure to a command error result. */
function rewindErrorResult(error: unknown): CommandResult {
  if (error instanceof RewindError) {
    const text = {
      'no-user-messages': t('noUserMessages'),
      'invalid-index': error.message,
      'not-a-user-message': error.message,
      'not-on-surface': error.message,
    }[error.code]
    return { kind: 'error', text }
  }
  throw error
}

/** Handle one `/rewind` invocation (two-step text flow + direct execution). */
async function handleRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  inflight: InflightRewinds,
  checkpointingEnabled: boolean,
  history?: HistoryHost,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const input = invocation.rawInput.trim()

  if (input === '') {
    // A bare `/rewind` in the composer is taken by the client's command
    // decoration (see src/client/index.ts), which opens the candidate picker
    // instead of running this host path; the button likewise drives this
    // parameterized path with an explicit `@seq` target. The bare form below
    // is a defensive fallback for non-composer callers: it withdraws the most
    // recent user message (time-travel back one turn; the text is offered
    // back in the composer).
    const candidates = listRewindCandidates(session.snapshotEvents(), session.surface.nodes, 1)
    if (candidates.length === 0) {
      return { kind: 'error', text: t('noUserMessages') }
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0]!.seq}`, inflight, checkpointingEnabled, history)
  }

  const parts = input.split(/\s+/)
  const target = parts[0]!
  const extra = parts[1]
  // V2 removed the `chat` / `both` mode argument. Reject any trailing token
  // loudly: silently ignoring it would let a stale caller believe only the
  // conversation was rewound, while both halves actually rewound.
  if (extra !== undefined) {
    return { kind: 'error', text: t('engine.modeRemoved', { extra }) }
  }
  return executeRewind(ctx, store, fs, invocation, target, inflight, checkpointingEnabled, history)
}

/** Whether THIS MOUNT already ran its one-shot auto-cleanup check. */
let autoSweepChecked = false

/**
 * One-shot lazy auto-cleanup gate. The FIRST session activity of a mount (a
 * user message or a tool result) performs a single check: it reads the policy
 * and the persisted last-sweep time and, only when enabled AND the configured
 * cadence has elapsed, runs the sweep and re-anchors the window on disk. After
 * that one check the mount stops considering auto-cleanup (a mount reads the
 * policy at most once), while the cadence survives a restart because the
 * last-sweep time is persisted rather than kept in memory. Runs in the
 * background (voided by callers) and NEVER rejects: an invalid config
 * fail-closes (deletes nothing) and logs, and a prune failure logs — neither
 * blocks the activity that triggered it. The active `sessionId` is the one
 * directory that must never be pruned.
 *
 * The gate is re-armed by every `apply` (see the reset there), so a live
 * disable → enable round trip checks again instead of inheriting the previous
 * mount's "already checked" flag.
 * @param signal - the mount's lifecycle signal; an aborted mount writes nothing.
 */
async function maybeRunAutoCleanup(
  ctx: Context,
  store: SnapshotStore,
  sessionId: string | undefined,
  dshHome: string | undefined,
  sweepIntervalMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (autoSweepChecked || signal?.aborted === true) return
  autoSweepChecked = true
  try {
    await runAutoCleanupCheck({
      pruner: store,
      readConfig: () => readCleanupPolicy(),
      statePath: resolveCleanupStatePath(dshHome),
      log: msg => ctx.logger.warn(msg),
      ...(sweepIntervalMs === undefined ? {} : { intervalMs: sweepIntervalMs }),
      ...(signal === undefined ? {} : { signal }),
    }, sessionId)
  } catch (error) {
    // The helper is contracted never to reject; this covers the one remaining
    // path — a logger on an already-disposed context — so an unload can never
    // surface as an unhandled rejection.
    try {
      ctx.logger.warn(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // The context is disposed and its logger is gone: nothing left to report.
    }
  }
}

/**
 * Read the resolved cleanup policy from the config-backed store. Without a
 * resolved config (a mount without the Loader, so nowhere to write) the read
 * fails closed: an error, deleting nothing.
 */
async function readCleanupPolicy(): Promise<{ ok: true; config: CleanupConfig } | { ok: false; error: string }> {
  if (cleanupStore === undefined) {
    return { ok: false, error: 'cleanup policy unavailable; snapshot cleanup policy cannot be read' }
  }
  return { ok: true, config: cleanupStore.load() }
}

/** Persist a validated cleanup policy through the config-backed store. */
async function writeCleanupPolicy(next: CleanupConfig): Promise<void> {
  if (cleanupStore === undefined) throw new Error('cleanup policy unavailable; snapshot cleanup policy cannot be written')
  await cleanupStore.save(next)
}

/** Render a {@link PruneStaleReport} for the `run` sub-command (dry vs apply). */
function formatCleanupReport(report: PruneStaleReport): string {
  const key: HostKey = report.dryRun ? 'cleanup.runDry' : 'cleanup.runApply'
  const text = t(key, {
    deleted: report.deleted,
    freed: report.freedBytes,
    kept: report.kept,
    remaining: report.remainingBytes,
  })
  return report.skippedActive > 0 ? `${text}\n${t('cleanup.skipped', { skipped: report.skippedActive })}` : text
}

/**
 * Handle one `/snapshot-auto-cleanup` invocation: view or configure the
 * persistent cleanup policy, or run the sweep now. All writes go through the
 * validated save, so the config file is never left invalid; a read of an
 * invalid file fail-closes the sweep (and reports on `status`/`run`).
 */
async function handleSnapshotCleanup(
  store: SnapshotStore,
  invocation: CommandInvocation,
  dshHome: string | undefined,
  trackedBySession: Map<string, Set<string>>,
): Promise<CommandResult> {
  const parsed = parseCleanupCommand(invocation.rawInput)
  if ('error' in parsed) return { kind: 'error', text: t('cleanup.usage') }
  switch (parsed.action) {
    case 'status': {
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      return {
        kind: 'success',
        text: t('cleanup.status', {
          state: t(loaded.config.enabled ? 'cleanup.enabled' : 'cleanup.disabled'),
          days: loaded.config.maxAgeDays,
        }),
      }
    }
    case 'on':
    case 'off': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), enabled: parsed.action === 'on' }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t(parsed.action === 'on' ? 'cleanup.onOk' : 'cleanup.offOk') }
    }
    case 'max-age': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), maxAgeDays: parsed.value! }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t('cleanup.maxAgeOk', { days: parsed.value! }) }
    }
    case 'run': {
      const apply = parsed.apply
      // `--current` re-targets the manual action to the ACTIVE session's
      // snapshots (the "clear this session now" path); without it, `run` keeps
      // its age-based stale-session sweep semantics.
      if (parsed.target === 'current') {
        return handleClearCurrent(store, invocation, apply, trackedBySession)
      }
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      try {
        const report = await store.pruneStale({
          keepActiveId: invocation.agent.session.id,
          maxAgeDays: loaded.config.maxAgeDays,
          dryRun: !apply,
        })
        // A real (non dry-run) sweep also re-anchors the 24h window, so the
        // automatic sweep does not immediately re-run after a manual one.
        if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now())
        return { kind: 'success', text: formatCleanupReport(report) }
      } catch (error) {
        return { kind: 'error', text: t('cleanup.runFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
    }
  }
}

/** Render a {@link ClearSessionReport} for the current-session clear (dry vs apply). */
function formatClearReport(report: ClearSessionReport): string {
  const key: HostKey = report.dryRun ? 'cleanup.clearDry' : 'cleanup.clearApply'
  return t(key, {
    entries: report.entries,
    bytes: report.bytes,
  })
}

/**
 * Handle the `run --current` manual clear of the ACTIVE session. Without
 * `--apply` it is a dry-run preview (disk and memory untouched); with it, the
 * session's entire snapshot directory is deleted and the in-memory tracked set
 * dropped, so the next user-message boundary re-derives an empty tracked set
 * instead of re-scanning every formerly-tracked file (the lag relief).
 *
 * The `--apply` mutation must only run once the session is STOPPED: a running
 * turn (the LLM thinking/outputting/editing, actively driving write tools)
 * would otherwise let a concurrent `recordBackup` at `tools/post-execute`
 * interleave with this directory `rm` and the in-memory dedup reset, leaving a
 * dangling dedup link (restore resolution then fails per-file). Mirroring
 * `rewind`, we ACTIVELY pause the running turn — cancel it and wait for
 * quiescence — before clearing; if it cannot stop, we error (`stopFailed`) and
 * never clear, so the plugin is never left corrupted. `agent.status` reads
 * `idle` during a maintenance phase and the boundary re-check is fire-and-forget,
 * so a mere status read is not enough — the `whenIdle` race is required, exactly
 * as in `executeRewind`.
 *
 * Clearing is an explicit abandonment of this session's snapshot archive, so it
 * is not gated on any restore-journal state (a clear and a restore never
 * interleave; any non-terminal journal found is a stale orphan from a previous
 * process). The memory reset is the part that must never be skipped — it is
 * what keeps restore resolution and the boundary re-check correct afterwards.
 */
async function handleClearCurrent(
  store: SnapshotStore,
  invocation: CommandInvocation,
  apply: boolean,
  trackedBySession: Map<string, Set<string>>,
): Promise<CommandResult> {
  const { agent } = invocation
  const sessionId = agent.session.id
  // Only the apply (mutation) path needs quiescence: a dry-run is a pure read.
  if (apply) {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: t('cleanup.clearActive', { sessionId }) }
      }
    }
    if (invocation.signal.aborted) {
      return { kind: 'error', text: t('cleanup.clearCancelled') }
    }
  }
  try {
    const report = await store.clearSession(sessionId, { dryRun: !apply })
    if (!report.dryRun) trackedBySession.delete(sessionId)
    return { kind: 'success', text: formatClearReport(report) }
  } catch (error) {
    return { kind: 'error', text: t('cleanup.clearFailed', { detail: error instanceof Error ? error.message : String(error), sessionId }) }
  }
}


/** The Loader's nested-include id prefix, between this fiber and its profile row. */
const INCLUDE_ENTRY_PREFIX = 'include:'

/** This fiber's own Loader entry id, when the mount has one (a bare `apply` does not). */
function rewindConfigKey(ctx: Context): string | undefined {
  return (ctx as { fiber?: { entry?: { id?: string } } }).fiber?.entry?.id
}

/**
 * The settings entry id this plugin's configuration is addressed by: the PROFILE
 * ROW id from the bundle's patch, not this fiber's nested include id. The loader
 * mounts a bundle's rows under an `include:` scope, so the fiber id carries that
 * prefix while the configuration editor keys entries and profile patches by the
 * bare row id.
 * @param entryId - this fiber's Loader entry id, when it has one.
 * @returns the configuration key, or undefined without an entry.
 */
export function profileEntryKey(entryId: string | undefined): string | undefined {
  if (entryId === undefined) return undefined
  return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(INCLUDE_ENTRY_PREFIX.length) : entryId
}


/**
 * Register the `/rewind` command and the checkpoint pipeline (before-capture
 * at `tools/execute`, disk commit at `tools/post-execute`).
 *
 * The command is fs-independent and registers immediately. The checkpoint
 * pipeline needs `fs` to resolve tracked paths to their real display paths,
 * so it mounts through a dynamic `ctx.inject(['fs'])` — it takes effect
 * whenever the fs service becomes available (and never fails the plugin's
 * load when a deployment has no fs; without it, no entries are recorded and
 * `both` restores report "no tracked changes").
 *
 * Capture runs in `tools/execute` (the around-dispatch stage), NOT in
 * `tools/pre-execute`: a pre-execute `{ kind: 'ask' }` short-circuit from
 * another plugin (e.g. dsh-edit-approval) skips later pre-execute listeners,
 * and a denied call never dispatches — so approved calls are still captured,
 * denied calls never leave a pending entry behind. Entries are committed to
 * disk at `tools/post-execute` under the turn's anchor message seq.
 *
 * @param ctx - context carrying `commands`, `tools`, and an optional `fs`.
 * @param config - resolved plugin config: the store options (`snapshotDir`,
 *  `dshHome`, `dedup`) plus the live policy (`fileCheckpointingEnabled`, cleanup
 *  `enabled`/`maxAgeDays`).
 */
export function apply(ctx: Context, config?: Config): void {
  // Fresh per-mount host state: these live at module scope because module-level
  // helpers read them without a ctx thread, and a fired one-shot sweep gate or
  // the previous mount's policy store would otherwise survive a live
  // disable → enable round trip. The locale is re-read here rather than reset,
  // so the command descriptions registered below carry the user's language.
  activeLocale = readHostLocale(ctx)
  cleanupStore = undefined
  autoSweepChecked = false
  // Cancels this mount's in-flight background work when the fiber disposes: the
  // live plugin manager can unload the plugin at any moment, and neither async
  // listener body may keep writing to disk or reading a disposed service.
  const lifecycle = new AbortController()
  ctx.effect(() => () => { lifecycle.abort() }, 'dsh-rewind lifecycle abort')

  // Own config card, so opt out of the schema-generated page (`autoGenerate`).
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-rewind page policy')
  })

  const dshHome = config?.dshHome
  const store = new SnapshotStore(config?.snapshotDir, {
    dedup: config?.dedup,
    dshHome,
    maxFileBytes: config?.maxFileBytes,
    maxAnchorGroups: config?.maxAnchorGroups,
  })
  // ---- rewind history (audit trail, never a restore source) ----
  // Root: alongside an explicit snapshot root, else `<dsh home>/rewind-history`.
  // `historyEnabled` / `historyLimit` / `historyPreview` stay live references,
  // so a settings write is visible on the next entry without a remount.
  const historyRoot = config?.snapshotDir !== undefined
    ? join(dirname(config.snapshotDir), 'rewind-history')
    : join(resolveDshHome(dshHome), 'rewind-history')
  const historyStore = new HistoryStore({
    root: historyRoot,
    limit: config?.historyLimit ?? 10,
    preview: config?.historyPreview ?? true,
  })
  const historyHost: HistoryHost = {
    store: historyStore,
    preview: config?.historyPreview ?? true,
    // Conversation archives sit next to the history partitions: same lifetime,
    // same "audit trail, never a restore source" role.
    archiveRoot: config?.snapshotDir !== undefined
      ? join(dirname(config.snapshotDir), 'rewind-archives')
      : join(resolveDshHome(dshHome), 'rewind-archives'),
    enabled: () => config?.historyEnabled?.get() !== false,
  }
  // A fire-and-forget append must not outlive the mount: the harness may tear
  // the data directory down right after disposal, and a late write would race
  // that cleanup (observed as ENOTEMPTY on Windows).
  ctx.effect(() => () => historyStore.dispose(), 'dsh-rewind history dispose')
  // The cleanup policy reads the config's live references, so a settings write
  // is visible here without a remount; writes go through the settings service's
  // entry API, which is the only owner of the document and addresses entries by
  // their PROFILE ROW id (`dsh-nonead-prompt-rewind`), not by this fiber's nested
  // include id (`include:dsh-nonead-prompt-rewind`). `settings` is a declared inject,
  // so the service is reachable as `ctx.settings`; without a resolved config or
  // a Loader entry there is nowhere to write, and the policy stays fail-closed
  // (reads report "unavailable", a sweep deletes nothing).
  const configKey = profileEntryKey(rewindConfigKey(ctx))
  if (config !== undefined && configKey !== undefined) {
    const writer: CleanupConfigWriter = {
      entryId: configKey,
      update: (id, patch) => ctx.settings.update(id, patch),
      clear: (id, fields) => ctx.settings.mutate(id, fields.map(field => ({ op: 'unset' as const, path: [field] }))),
    }
    cleanupStore = volatileCleanupStore(config, writer)
  }
  // Pending before-captures keyed by agent id + callId (callIds are unique,
  // but scoping by agent makes cross-session collisions impossible).
  const pending = new Map<string, PendingCapture>()
  // Files that existed BEFORE a mutating shell command ran, keyed by
  // agent:callId. The post-execute pass diffs this against the tree to find
  // what the command removed and re-anchors those paths at the deleting turn.
  const scanBefore = new Map<string, Set<string>>()
  // A capture staged at `tools/execute` is consumed at `tools/post-execute` (or
  // dropped at `tools/result`); neither runs for a fiber disposed in between, so
  // the bytes would linger until `prune` calls them stale. `discardCapture` is
  // idempotent, and the async disposer keeps the fiber inert until they are gone.
  ctx.effect(() => () => {
    const captures = [...pending.values()]
    pending.clear()
    return Promise.all(captures.map(capture => discardCapture(capture))).then(() => undefined)
  }, 'dsh-rewind dispose pending captures')
  // Incremental turn-anchor cache, keyed by the Session object (see
  // anchorSeqOf).
  const anchorCache = new WeakMap<Session, AnchorCacheEntry>()
  // Sessions with a rewind currently executing (per-session in-flight guard).
  const inflight: InflightRewinds = new Set()
  // Per-session tracked path sets (seeded lazily from the snapshot store; a
  // path joins as soon as a write-class tool commits an entry for it). Used
  // by the user-message boundary re-check below.
  const trackedBySession = new Map<string, Set<string>>()
  // The fs service, captured from the dynamic `ctx.inject(['fs'])` scope and
  // handed to the command path for the post-restore observation sync.
  // Undefined until the service mounts (or in fs-less deployments): the sync
  // then degrades to a no-op and the pre-existing stale-error fallback stays.
  let fsService: FileSystem | undefined

  ctx.effect(function* () {
    /**
     * Refresh the host language, then run the handler: a command result is the
     * surface the user reads, and the preference can change without a remount.
     */
    const withHostLocale = (
      handler: (invocation: CommandInvocation) => Promise<CommandResult>,
    ): ((invocation: CommandInvocation) => Promise<CommandResult>) =>
      (invocation) => {
        activeLocale = readHostLocale(ctx)
        return handler(invocation)
      }
    // One handler serves `/rewind` and its alias `/undo`.
    const rewindHandler = withHostLocale(
      (invocation: CommandInvocation) => handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config), historyHost),
    )
    // The engine channel is machine-driven: a human reaching it (menu pick or
    // typed line) is sent to the front doors instead of shown its grammar.
    const engineHandler = withHostLocale(
      (invocation: CommandInvocation) => invocation.rawInput.trim() === ''
        ? Promise.resolve<CommandResult>({ kind: 'error', text: t('engine.rejected') })
        : handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config), historyHost),
    )
    // Each registration is isolated so a name another plugin owns costs only
    // that name (issue #49). Cordis rolls a failed effect back, so one
    // unguarded throw would also take the checkpoint pipeline below down.
    try {
      yield ctx.commands.register({
        name: 'rewind',
        description: t('command.description'),
        handler: rewindHandler,
      })
    } catch (error) {
      warnCommandUnavailable(ctx, 'rewind', error)
    }
    try {
      yield ctx.commands.register({
        name: 'undo',
        description: t('command.undoDescription'),
        handler: rewindHandler,
      })
    } catch (error) {
      warnCommandUnavailable(ctx, 'undo', error)
    }
    try {
      yield ctx.commands.register({
        name: ENGINE_COMMAND,
        description: t('engine.description'),
        input: { hint: t('engine.inputHint') },
        handler: engineHandler,
      })
    } catch (error) {
      warnCommandUnavailable(ctx, ENGINE_COMMAND, error)
    }
    try {
      yield ctx.commands.register({
        name: 'snapshot-auto-cleanup',
        description: t('cleanup.description'),
        input: { hint: t('cleanup.inputHint') },
        handler: withHostLocale(invocation => handleSnapshotCleanup(store, invocation, dshHome, trackedBySession)),
      })
    } catch (error) {
      warnCommandUnavailable(ctx, 'snapshot-auto-cleanup', error)
    }
  }, 'dsh-rewind command')

  // Session-format-version guard: after DSH migrates/loads a session, clear
  // that session's snapshots when they were anchored under a DIFFERENT session
  // format — their seq references would be mis-mapped by the v2→v3 migration.
  // Conservative per the "delete stale snapshots" policy: a legacy dir with no
  // recorded format marker is discarded too. Subagent sessions are skipped
  // (they are never rewind targets and record no snapshots).
  // Not gated by the switch: this guard deletes incompatible snapshots, never creates them.
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const session = agent.session
    if (isSubagentSession(session)) return
    void (async () => {
      try {
        // An unload between the event and this body must not write under a
        // disposed owner (the fiber's disposer aborts this signal).
        if (lifecycle.signal.aborted) return
        // Stamp snapshots recorded after this point with the loaded session's
        // format, so a future format change is detected.
        store.setFormatVersion(session.header.version)
        // Plugin store-format guard FIRST: snapshots written by a NEWER build
        // are never touched (no clear, no write, no restore plan — ADR-10).
        // The order matters: the session-format reconcile below CLEARS the
        // whole session dir on a mismatch, which would delete snapshots this
        // build cannot even read.
        try {
          await store.assertKnownStoreVersion(session.id)
        } catch (error) {
          ctx.logger.warn(`[dsh-rewind] file restore disabled for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        if (lifecycle.signal.aborted) return
        // Clear snapshots anchored under a different (now-migrated) session
        // format: their seq references would be mis-mapped by the migration.
        const result = await store.reconcileFormatVersion(session.id, session.header.version)
        if (result.cleared) {
          ctx.logger.warn(`[dsh-rewind] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`)
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] session-format reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, { global: true })

  // User-message boundary re-check (Claude Code's fileHistoryMakeSnapshot
  // analog): every time a user/message lands in a session log, re-read every
  // tracked file of that session and record a before-backup for any whose
  // on-disk state changed since it was last recorded (including EXTERNAL
  // edits and deletions the write-class capture never saw). The change test
  // uses the store's single last-known-state source, so only CHANGED files
  // are recorded (a full snapshot; unchanged ones stay in memory, no per-
  // message dedup file). The entry is anchored at the boundary message, so a
  // later rewind to this message restores the file to this exact state — and
  // a rewind to an earlier message restores an earlier entry. Subagent
  // sessions are skipped (their edits are not tracked, matching captureBefore).
  // Runs async off the append hot path; failures are logged, never blocking
  // the message.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    if (isSubagentSession(session)) return
    // A rewind in flight must never start a pass that reads the tracked files:
    // `executeRewind` appends its marker through `Session.append`, which
    // dispatches this listener SYNCHRONOUSLY, so the marker's own pass would
    // run while `restoreAfter` is writing those very files (mode `both`) and
    // record a torn or pre-restore state. A pass skipped here is re-derived at
    // the next real boundary, so deferring loses nothing.
    if (inflight.has(session.id)) return
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return
        const sessionId = session.id
        // Lazy auto-cleanup: a user message is the practical first trigger of a
        // day; it runs in the background and fail-closes on config error.
        void maybeRunAutoCleanup(ctx, store, sessionId, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
        // Cleanup above stays independent; the switch stops NEW checkpoints only.
        if (!isFileCheckpointingEnabled(config)) return
        let tracked = trackedBySession.get(sessionId)
        if (tracked === undefined) {
          tracked = await store.trackedPaths(sessionId)
          trackedBySession.set(sessionId, tracked)
        }
        if (tracked.size === 0) return
        if (lifecycle.signal.aborted) return
        await reconcileTracked(store, sessionId, event.seq, tracked)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, { global: true })

  // `rpc.handle` registers its route inside an effect that reads `owner.webServer`,
  // where `owner` is the CONNECTION service's own define-site context. `webServer`
  // and `connection` live in different plugin fibres, so that read dead-ends at the
  // root fibre and throws `cannot get property "webServer" without inject` — the
  // channel then never exists and every client query reports "host RPC unavailable".
  // `rebaseOnRoot` moves only that define-site to the root context; see its doc.
  ctx.inject(['connection'], (scope) => {
    try {
      const proxied = scope.get('connection') as RewindRpcHost | undefined
      if (proxied === undefined) return
      const raw = rawServiceOf(scope, 'connection') as RewindRpcHost | undefined
      const host = raw === undefined ? undefined : rebaseOnRoot(raw, scope.root)
      const dispose = (host ?? proxied).rpc.handle(
        REWIND_RPC_CHANNEL,
        createRewindRpcHandler(
          store,
          () => scope.get('agents') as AgentLookup | undefined,
          () => isFileCheckpointingEnabled(config),
          () => historyHost,
          session => historyWorkspaceOf(ctx, session),
        ),
      )
      scope.effect(() => dispose, 'dsh-rewind RPC channel')
    } catch (error) {
      ctx.logger.warn(`[dsh-rewind] RPC channel registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.inject(['fs', 'workingDirectory'], (scope) => {
    const fs = scope.fs
    const workingDirectory = scope.workingDirectory
    // Expose the fs service to the command path (restore observation sync).
    // Undefined before the service mounts: the sync then degrades to a no-op.
    fsService = fs
    // The scope disposes with either service: drop the captured reference so the
    // command path can never hand a released instance to the observation sync.
    scope.effect(() => () => { fsService = undefined }, 'dsh-rewind fs capture')
    scope.on('tools/execute', async (exec: ToolExecution, next): Promise<ToolExecutionResult> => {
      try {
        if (isFileCheckpointingEnabled(config)) {
          // Shell first: a mutating command can DELETE a file the write-class
          // capture has never seen, so every never-recorded workspace file is
          // backed up before the command runs. Ordering matters — this must be
          // the before-state of the command, not of whatever it leaves behind.
          if (isWorkspaceScanEnabled(config)) {
            const before = await captureWorkspaceFirstSightings(
              workingDirectory,
              store,
              anchorCache,
              trackedBySession,
              exec,
              config?.workspaceScanMaxFiles,
              config?.workspaceScanMaxBytes,
            )
            if (before !== undefined) {
              scanBefore.set(`${exec.agent?.id ?? 'anon'}:${exec.callId}`, before)
            }
          }
          await captureBefore(fs, workingDirectory, store, exec, pending)
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
      try {
        // Lazy 24h auto-cleanup: a tool result is the fallback trigger (covers
        // LLM work that never landed a user/message); the session id is the
        // directory that must never be pruned. A subagent session is SKIPPED:
        // it owns no snapshot, so its id would claim the sweep's
        // active-session exemption while shielding nothing, and the session the
        // user is actually in (the parent) would lose that exemption. Nothing
        // is lost — the parent's own tool result (the subagent call itself)
        // triggers the same one-shot sweep with the correct id.
        const session = exec.agent?.session
        if (session !== undefined && !isSubagentSession(session)) {
          void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
        }
        // Deletion pass FIRST: a failed tool still may have removed files, and
        // the re-anchor must happen regardless of the command's exit status.
        const scanKey = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
        const scanSeen = scanBefore.get(scanKey)
        scanBefore.delete(scanKey)
        if (scanSeen !== undefined && isWorkspaceScanEnabled(config)) {
          await captureWorkspaceDeletions(
            workingDirectory,
            store,
            anchorCache,
            exec,
            scanSeen,
            config?.workspaceScanMaxFiles,
          )
        }
        await commitEntry(store, pending, anchorCache, trackedBySession, exec, result, isFileCheckpointingEnabled(config))
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/result', (exec: ToolExecution): undefined => {
      // A THROW inside the `tools/execute` waterfall — from another wrapper,
      // not from the tool body (`dispatchToolBody` catches body errors and
      // still produces a post-result, so the body path keeps post-execute) —
      // short-circuits the registry's catch straight to `final-result`,
      // skipping `tools/post-execute`; its before-capture would otherwise leak
      // in `pending` forever (staged bytes on disk, not just memory).
      // `tools/result` fires on BOTH the normal and the throw path: drop the
      // staged copy here as the safety net (a no-op once commit consumed it).
      const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
      const capture = pending.get(key)
      pending.delete(key)
      void discardCapture(capture)
      return undefined
    })
  })
}
