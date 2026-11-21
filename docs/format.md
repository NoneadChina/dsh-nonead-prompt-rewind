# Durable format

> Maintainer reference for every file this plugin writes. The implementation is the
> authority: `src/snapshot.ts` (checkpoint store), `src/history.ts` (rewind history)
> and `src/snapshot-cleanup.ts` (cleanup policy state). If this document and the
> code disagree, the code wins and this document is a bug.
## 1. Roots and resolution
Three independent roots:

| Data | Path | Owner |
| --- | --- | --- |
| Snapshot store | `<dsh home>/rewind-snapshots/` | `SnapshotStore` |
| Rewind history | `<dsh home>/rewind-history/` | `HistoryStore` |
| Cleanup clock | `<dsh home>/snapshot-cleanup-last-sweep.json` | `snapshot-cleanup.ts` |

`<dsh home>` resolves through `resolveDshHome`, whose precedence is the plugin config
`dshHome`, then `$DSH_HOME`, then `~/.dsh`. Two config fields move the other two roots:
an explicit `snapshotDir` replaces the snapshot root **and** puts history in
`<dirname(snapshotDir)>/rewind-history`; `historyLimit`, `historyPreview` and
`historyEnabled` tune the history store, not its location. The plugin reads no
environment variable of its own, and every root is a sibling of the workspace, never a
subtree of it.
Deleting a root only removes the stored data of that root; the conversation and the
workspace are untouched. The snapshot store rebuilds itself from the next tracked
mutation, and the history store starts a fresh partition.
## 2. Snapshot store layout

```text
<snapshot root>/
├── objects/
│   └── <sha256>                             # global content-addressed pool entry (hard link)
└── <sessionId>/
    ├── store                                  # plugin store-format marker ("3")
    ├── format                                 # DSH session-format marker (session.header.version)
    ├── <anchorSeq>/                           # decimal seq of the anchoring user/message
    │   ├── <callId-base>.json                 # one committed entry (metadata)
    │   └── <callId-base>.before               # its raw byte sidecar (the before content)
    ├── .pending/
    │   └── <capture-base>.before              # captures staged but not yet committed
    ├── rescue/<opId>/<n>.before               # one pre-restore ("rescue") copy per action
    ├── journal-<opId>.json                    # one restore-op journal (current prefix)
    └── restore-journal-<opId>.json            # the legacy prefix, still readable
```
- `objects/` holds one file per distinct sidecar content, named by the SHA-256 of its bytes. Every committed sidecar is hard-linked here, so identical
  bytes captured by different sessions (or different turns) share one inode. The pool is a deduplication layer only: an entry always names its own
  sidecar, so reads and restores never depend on the pool, and a missing object is repaired from the sidecar on the next commit.
- `<sessionId>` is `safeSessionId(sessionId)`: everything outside `[a-zA-Z0-9._-]` becomes `_`, and the bare values `.` and `..` become `session`, so
  a hostile id cannot traverse out of the root.
- `<anchorSeq>` is a decimal integer. Readers only accept numeric directories as anchor groups; any other name in the session directory is ignored.
- `.json` files in an anchor group are entries. Marker files are deliberately **not** `.json`, so they never count as checkpoint entries.
- Restore journals are recognized by the `journal-` prefix, plus the legacy `restore-journal-` prefix, which is read and updated in place.
## 3. Names and sanitization
One entry is one tool call, filed under the anchor group of the turn that made it:

```text
<callId-base>   = safeFileId(callId) + "-" + sha256(callId).slice(0, 8)
safeFileId(x)   = x with every character outside [a-zA-Z0-9._-] replaced by "_"
```
The digest disambiguates call ids that sanitize to the same name (`a:b` and `a_b`), so
two different calls can never overwrite each other's bytes. Readers never derive a
name: every reference names its target file, which is why entries written under older
naming rules keep resolving.
A staged capture uses the same construction with a synthetic key (the capture key, or
`recheck-<anchorSeq>-<sha256(path).slice(0, 8)>` for a boundary re-check).
## 4. Session markers
Two small atomically-written files, both non-`.json`:

| File | Value | Meaning |
| --- | --- | --- |
| `store` | decimal integer (`3`) | On-disk format the store writes. Missing means the legacy string format. |
| `format` | decimal integer | `session.header.version` at the time snapshots were recorded. |

`store` is stamped once per process per session, alongside the first entry. `format` is
stamped at `agent/created` and whenever an entry is recorded. The two are independent:
`store` protects the plugin's byte layout, `format` protects the seq anchoring against a
DSH session-format migration. A `format` value that differs from the loaded session's
version clears that session's snapshot directory at `agent/created` instead of
re-mapping seq references.
## 5. Checkpoint entry
One JSON file per before-backup, written as `<callId-base>.json` next to its
`<callId-base>.before` sidecar:

```ts
interface CheckpointEntryJson {
  store: 3            // on-disk format; absent or 1 = the legacy string format, 2 = pre-pool
  callId: string      // the tool call that mutated the file
  file: string        // resolved display path (absolute) of the tracked file
  parent?: string     // realpath of dirname(file) at commit time (the location pin)
  blob: string | null // sidecar file name; null = the file did not exist (a creation)
  codec?: 'br'        // sidecar is brotli-packed; absent = raw bytes
  size: number        // logical byte length of the before content (0 when blob is null)
  mode?: number       // permission bits recorded at capture time (best effort)
  lossy?: true        // recorded from legacy content that had already lost bytes
  time: number        // epoch ms; strictly increasing within one store instance
}
```
Semantics a reader may rely on:

- **`blob` is the pre-edit state.** A string names the sidecar holding the exact before bytes, copied raw (never decoded into a JS string), so binary
  and non-UTF-8 files round-trip byte-exactly. The name is an invariant: it must equal this entry's own file name with `.json` replaced by `.before`.
  A sidecar that is missing or not a regular file is an integrity failure — never a silent "the file was created". For a raw sidecar the file size
  must equal `size`; for a packed sidecar (`codec: 'br'`) the decoded length must equal `size`, and a decode failure is that same integrity failure.
- **`codec` is optional and additive.** When a text sidecar of at least 1 KiB compresses by more than a small margin, it is brotli-packed and the
  entry records `codec: 'br'`; `size` stays the logical before length, so budgets still account the real on-disk `storedSize` while restores and
  previews use `size`. A reader that does not know a codec must treat the entry as unreadable (fail closed) rather than hand packed bytes to a
  restore; a `lossy` record never carries a codec.
- **Size cap.** A regular file larger than `DEFAULT_MAX_FILE_BYTES` (8 MiB) is not backed up;
  the cap is exposed as `maxFileBytes`, where `0` disables it. The capture is skipped entirely
  — never recorded as a creation, which a rewind would turn into a delete. The automatic
  first-sight scan uses the lower `DEFAULT_SCAN_MAX_FILE_BYTES` (1 MiB).
- **Capture policy.** Before staging, `decideSnapshotPath` refuses temporary/render directories,
  media/binary extensions, and (unless `snapshotBinaries` is on) files whose first 8 KiB contain a
  NUL byte; `snapshotIncludeGlobs` overrides extension and sniff refusals, `snapshotExcludeGlobs`
  adds refusals. A refused path is remembered per session so `uncovered` names it; nothing about
  the on-disk format changes.
- **Byte budgets.** `maxSessionBytes` (default 256 MiB) evicts the oldest whole anchor groups as
  soon as a commit crosses it, and `maxTotalBytes` (default 2 GiB) evicts the least-recently-active
  session directories (never one currently being driven) down to 80%. Eviction is link-aware and
  reuses `prune`, so no surviving link dangles; a pinned recovery journal may keep a group alive.
- **Retention horizon.** `retentionDays` (default 7; `0` disables it) makes `prune` evict groups
  older than the window even below `maxAnchorGroups`, while always keeping the newest
  `DEFAULT_MIN_ANCHOR_GROUPS` (30) groups. The highest evicted `anchorSeq` is written to a
  `pruned` file in the session directory (plain decimal text, atomic temp+rename, monotonic).
  `pruned` is non-numeric beside numbered anchor directories, so it is never read as an entry or a
  group; a missing or unparsable file means `0` ("never pruned"). A target below the watermark
  cannot restore files: preview reports `filesUnavailable` and the rewind skips the restore pass
  rather than applying an empty plan. The effective horizon is
  `max(retentionDays, cleanup maxAgeDays)`: the byte budgets and the age sweep share one window, so
  a snapshot the inactivity policy promises to keep is never evicted early by the configured
  horizon (when the cleanup window is shorter, `retentionDays` still applies).
- **`blob: null` means the call created the file.** It is valid only with `size: 0` and never together with `lossy`; a contradiction is corruption,
  because guessing an entry's kind is how a restore turns into a delete.
- **`anchorSeq` is the parent directory**, deliberately not a field. Rewinding to message N applies every entry anchored at or after N — the boundary
  is inclusive, so the rewind also reverts the changes its own turn caused.
- **`parent` is the location pin.** A restore refuses the path when its directory no longer resolves there, so a repointed ancestor cannot redirect
  the write (or the unlink of a recorded creation) outside the recorded location. Absent means "no pin", and the restore falls back to the
  final-component link check alone. A malformed pin is ignored, never treated as corruption.
- **`mode` never decides an action** (a mode-only difference is a no-op); it is applied best-effort only when content is written back.
- **`lossy` marks content whose original bytes are unknowable.** Such a record can be compared against the disk but must never be written back, so it
  cannot overwrite a live file.
- **`time` is the ordering key inside an anchor group.** It is monotonic per store instance (bumped past the previous commit), so same-millisecond
  commits stay capture-ordered and a re-read always selects the same earliest entry per path.
## 6. Object pool and garbage collection
Store version 3 adds the root-level `objects/` pool. It is not part of any entry: writing a
sidecar also links it to `objects/<sha256>` (temporarily `objects/<sha256>.cas` if the link has
to be replaced), and readers never look there. The hash is over the stored bytes, so a packed
text sidecar and its raw form are different objects; `codec` lives only in the entry. Hard links
are best-effort — a filesystem that
refuses them (FAT, some permission setups) simply keeps the per-entry copy, which is why the
pool is an optimization, not a correctness requirement.

- **Garbage collection** treats an object as garbage when `lstat().nlink <= 1`: no sidecar
  references it any more. A live object always has at least two links (the pool entry and its
  sidecar), so a concurrent commit cannot be collected. `clearSession`, `enforceTotalBudget` and
  a real `pruneStale` sweep run GC at the end; `gcObjects({ dryRun: true })` only reports.
- **Migration** (`/snapshot-auto-cleanup migrate`, dry-run unless `--apply`) walks every
  session's anchors, publishes each sidecar into the pool, and replaces a duplicate sidecar with
  a hard link to the existing object. The report counts scanned/linked/deduped/reclaimed bytes;
  an applied migration ends with a GC pass. Running it on an already-migrated store is a no-op.
- **`objects/` is never a session.** It is skipped by `sessionDirs()`, `pruneStale` and the byte
  budgets; only GC and migration touch it.

## 7. Dedup link entry
When a tracked file's new before-state is byte-identical to its immediately-prior entry,
the entry is stored as a link instead of a second copy:

```ts
interface LinkEntryJson {
  store: 3
  callId: string
  file: string
  ref: string        // "<anchorSeq>/<callId-base>.json" of the immediately-prior entry
  parent?: string    // its own location pin
  time: number
}
```
A reader resolves `ref` to the terminal real snapshot, following a strictly backward,
acyclic chain. A dangling or cyclic link is a per-file failure, never a silent drop. A
`ref` must be a single-level `<digits>/<file>.json` relative reference; traversal,
absolute paths and unknown roots are corruption (on write the ref is normalized to
POSIX separators so a journal written on one platform is readable on another). `prune`
materializes a surviving link whose referent sits in a group it is about to drop, so no
kept link is left dangling; the materialized entry keeps the bytes and the link's own
location pin, but not the referent's `mode`.
## 8. Restore journal
One JSON file per restore operation, written **before the first mutation** and updated as
the pass applies:

```ts
type ByteRef = { blob: string } | { text: string } // session-relative byte file, or inline text
interface RestoreJournalJson {
  version: 1 | 2                // 2 = byte references (current), 1 = inline strings
  id: string                    // "<epoch-ms>-<8 random chars>" or "op-<base36 ms>-<random>"
  sessionId: string
  targetSeq: number             // rewind target the restore belongs to
  startedAt: number             // epoch ms
  finishedAt?: number           // set on a terminal state
  state: 'running' | 'rollback-running' | 'completed' | 'rolled-back' | 'recovery-required'
  actions: RestoreJournalAction[]
  dialog?: { role: 'user' | 'assistant'; content: unknown[] }[]  // messages the rewind shadowed
  rollbackError?: string        // a rollback pass failed partway
}
interface RestoreJournalAction {
  path: string
  action: 'restore' | 'delete'  // restore = write content back; delete = unlink
  before: ByteRef | null        // target content for restore; null for delete
  rescue: ByteRef | null        // pre-restore disk state; null = the file was absent
  rescueError?: string          // the rescue capture failed; rollback skips this path
  mode?: number                 // recorded target permissions
  rescueMode?: number           // recorded pre-restore permissions
  parent?: string               // checkpoint-time location pin, copied from the entry
  beforeSha256?: string         // SHA-256 of the logical `before` bytes (post-codec)
  beforeSize?: number           // logical size those bytes decode to
  done: boolean                 // the fs op completed and was marked
  failed?: string               // per-action failure message (the pass never aborts)
}
```
A `{blob}` ref is session-relative and validated on both write and read, so a corrupt or
hostile journal cannot point a restore or rollback outside the session directory. It
names either an entry sidecar (`<anchorSeq>/<callId-base>.before`) or a rescue copy
(`rescue/<opId>/<n>.before`). `{text}` refs carry content with no sidecar: a legacy
entry's inline string, or a legacy journal's inline strings.
State machine: `running` and `rollback-running` are non-terminal; `rolled-back` is terminal
and is recycled with its rescue bytes by the next prune pass. `completed` is also settled,
but it doubles as the session's **undo record**: pruning keeps the newest completed journal
and the anchor groups its stale check reads, and a new rewind retires the previous undo
record (journal plus `rescue/`) before writing its own. A completed journal therefore
survives ordinary pruning but never accumulates — at most one exists per session.
Reconciliation reports a still non-terminal op as `interrupted`, and a `recovery-required` op
when a rollback could not complete or the journal is corrupt; the journal's own `state` stays
non-terminal in both cases. A `recovery-required` or `rollback-running` journal can be
retried: the next undo resumes the rollback from the recorded rescue state.

An undo's stale check compares the disk against the **logical** `before` bytes. A journal
action that carries `beforeSha256`/`beforeSize` is judged by hashing the current file
(post-codec size), so pruning that action's sidecar no longer turns a still-valid undo into
`stale-undo`; such a record also stops pinning its anchor group. Legacy journals without a
fingerprint keep the old ref-based check and report `undo-unavailable` with reason
`snapshot-pruned` when the ref is gone — never `stale-undo`.

`clearSession` writes a root-level `.cleared/<sessionId>` tombstone containing the highest
anchor it removed. `readPrunedThrough` falls back to that tombstone, so a preview of a
cleared session reports file restore as unavailable instead of rendering an empty diff;
the next snapshot recorded for that session deletes the tombstone again.

### Dialogue replay
A journal may also carry `dialog`: the user and assistant text messages the rewind
shadowed, captured from the shadowed seqs. Undo republishes them as **new events**
(`surfaceOp: 'append'`) after the file rollback succeeds — the surface has no inverse of
`replace`, so the original nodes stay shadowed forever and the log keeps both copies.
Only human user messages and assistant `text` blocks are kept; tool calls/results,
reasoning, usage and stream data are not replayed, and the republished assistant events
use `turn: 0, step: 0`. A rewind that only shadowed dialogue (no file actions) still
writes a journal with `actions: []` plus `dialog`, so a conversation-only rewind can be
undone exactly once. A journal without `dialog` (legacy) remains file-only.
## 9. Rewind history partition
History is a separate root with a separate schema and lifetime:

```text
<dsh home>/rewind-history/
└── <workspaceKey>/
    └── history.json
```
The partition key is resolved host-side from the active session:

- `ws-<safeKeySegment(workspaceId)>` when the workspace registry accounts for the session (reverse lookup over `WorkspaceView.sessionIds`);
- `_unknown` otherwise. `cwdKey()` (a `cwd-<sha256(realpath)[0..12]>` fallback) exists in the module, but the current host wiring resolves partitions
  from the registry only.

```ts
interface HistoryFileJson {
  version: 1
  workspace: { key: string; workspaceId?: string; path?: string }
  entries: HistoryEntryJson[]      // oldest first, at most historyLimit (default 10)
}
interface HistoryEntryJson {
  opId: string                     // "<at>-<8 random chars>"; shares the restore journal id
  workspaceKey: string             // redundant copy, guards hand-moved files
  workspaceId?: string
  sessionId: string
  sessionTitle?: string
  at: number                       // epoch ms of the rewind
  targetSeq: number                // target user-message seq; -1 when unresolved
  hadFiles: boolean                // the rewind touched files (a journal exists)
  outcome: 'success' | 'failed' | 'partial'
  shadowedEvents: number           // log events shadowed by the marker
  messagePreview: string           // target text, whitespace collapsed, at most 80 chars
  attachments: number
  files?: {                        // present when a restore pass ran
    restored: number
    deleted: number
    skipped: number
    uncovered: number
    preview: readonly string[]     // at most 20 affected paths
  }
  errorCode?: string               // stable failure code (e.g. inflight, stop-failed)
  errorText?: string               // host-rendered reason, at most 200 chars
  chainPrev?: string               // opId of the previous not-undone entry of the session
  undoable: boolean
  undoneAt?: number                // set at most once
  undoOutcome?: 'success' | 'partial'
  undoMode?: 'files' | 'files+refill' | 'files+resend'
}
```
Rules:

- The file is written tmp+rename; a half-written file is never visible.
- A partition holds at most `historyLimit` entries; overflow drops the oldest in the same serialized write (one `splice`). A serialized body above
  512 KiB is trimmed to the newest entries that fit rather than growing without bound.
- An unparseable file, an unknown `version`, or a non-object document is renamed to `history.json.corrupt-<epoch>` and replaced with an empty
  partition — never silently deleted.
- Writes for one partition serialize through a per-path promise chain, so concurrent appends cannot interleave a read-modify-write.
- An entry is never edited except for the undo bookkeeping fields (`undoneAt`, `undoOutcome`, `undoMode`). `chainPrev` and the
  `HistoryStore.chainTail` / `isChainTail` helpers make the newest not-yet-undone entry of a session the only undoable position.
## 10. Cleanup state file
The snapshot auto-cleanup policy is not a file: it is the plugin entry's own live
configuration (`autoCleanupEnabled`, `autoCleanupMaxAgeDays`). Only the sweep clock is
persisted:

```json
{ "lastSweepAt": 1767225600000 }
```
Path: `<dsh home>/snapshot-cleanup-last-sweep.json` (`resolveCleanupStatePath`). A missing,
unreadable or corrupt file reads as `0` ("never swept"), so the next activity runs a
sweep — safe because the sweep is idempotent and never targets the active session. The
write is atomic (temp + rename) and happens only after a real sweep, and only while the
mount is alive.
## 11. Write and recovery guarantees
- **Atomicity.** Every JSON write serializes to a sibling `<target>.tmp` and renames over the target. A crash leaves only a temp file, never a
  readable half-written target, and readers ignore temp files. A leftover temp is overwritten by the next write of the same target. The marker files
  (`store`, `format`) use the same temp+rename rule.
- **Bytes before metadata.** A commit places the sidecar first — a staged capture is `rename`d out of `.pending/`, other sources are written
  temp-then-rename — and only then publishes the entry JSON. A crash can therefore leave an unreferenced sidecar but never an entry whose bytes are
  missing.
- **Journal before mutation.** A restore captures the rescue state of every planned path as a raw byte copy and persists the intent journal
  (references only) before the first filesystem mutation; each action is marked `done` as it is applied.
- **Disk is truth.** Reconciliation compares the real disk against each action's goal (the restore target for `running` journals, the rescue state
  for `rollback-running` and `recovery-required` ones); a path that already matches is marked done without being touched. The plugin never reconciles
  on its own — an interrupted op stays interrupted until an explicit caller resolves it.
- **Bounded storage.** `prune` keeps the newest 100 anchor groups per session (`MAX_ANCHOR_GROUPS`) and materializes surviving links before deleting
  those directories; it recycles `rolled-back` journals with their `rescue/<opId>/` bytes, while the newest `completed` journal — the **undo record** —
  is kept together with the groups its stale check reads. `.pending/` captures older than 24 h are collected. A group a non-terminal or completed
  journal references is pinned, so the effective window may exceed the cap until that op is resolved or undone. A new restore retires the previous
  completed journal before writing its own, so the undo record never accumulates. Non-terminal and corrupt journals are always kept.
## 12. Validation and failure policy
- **Entries** are read defensively. A missing, malformed, or self-contradictory entry is read as `undefined` (skipped): losing one backup is
  acceptable, guessing is not. Contradictions are corruption — `blob: null` with `size !== 0`, `lossy` together with `blob: null`, a `blob` that is
  not this entry's sidecar name, or a malformed legacy record. A malformed `parent` is not corruption: it means "no pin". Two cases are **not** silent
  skips: an entry whose `store` is newer than this build fails the whole operation closed, and a record whose sidecar is missing or mis-sized is a
  per-file failure the restore reports.
- **Journals** fail loud. A corrupt or schema-invalid journal is reported as `recovery-required` and never dropped, because dropping it would
  silently erase the interrupted restore's recovery record. A ref with a traversal, absolute, or unknown segment counts as corrupt.
- **Journal IO** is best-effort by design: if a journal cannot be written, the restore proceeds with pre-journal semantics — crash safety degrades,
  behavior does not.
- **History** is an audit trail. A failed append is reported through the store's warning hook and never fails the rewind that produced it.
## 13. Versioning policy
The format is versioned at three levels, and compatibility means *reading old data*, not
repairing it:

- A session-level `store` marker and a self-describing `store` field on every entry. A missing marker (or `1`) is the legacy string format, which is
  still read but never migrated; entries carrying `2` are read unchanged (the object pool is not part of an entry), and `3` entries are read including
  the optional `codec` (a v3 record without one is just a raw sidecar). A value **above** the current
  `CURRENT_STORE_VERSION` (`3`) fails the automatic operations closed: no file restore, no new entry, and no age sweep into a store a newer build owns.
  The conversation rewind does not depend on snapshots and keeps working.
- **The explicit clear is the one deliberate exception.** `/snapshot-auto-cleanup run --current --apply` is the user's escape hatch for reclaiming
  space, so it may remove a directory a newer build owns; the report names the newer store it deleted (`newerStoreVersion`) so the loss is visible.
  Automatic cleanup (the age sweep) never touches such a directory.
- Journal `version: 1` (inline strings) and `version: 2` (byte references) are both read; a present version other than 1 or 2 is corrupt.
- `history.json` `version: 1` only; any other value moves the file aside as corrupt.

The byte format deliberately reuses none of the legacy entry key names (`path`,
`anchorSeq`, `before`) and does not carry `anchorSeq` in the entry body, because it equals
the parent directory. A legacy build therefore rejects such an entry instead of reading it
as "the file was created", so a downgrade cannot delete workspace files; that field-name
contract is pinned by `tests/downgrade-safety.test.ts`.
A future incompatible format should raise the relevant version (readers already fail
closed above their own) or move the state root and ship an explicit migration tool. Old
format data is never silently re-interpreted.
## 14. Format invariants
- Every path a reader follows is either rooted in the store root or explicitly validated as a session-relative, single-level reference.
- An entry's sidecar is named after the entry, sits beside it, and holds the exact bytes it claims (`size` matches).
- `anchorSeq` comes from the directory, never from the JSON body.
- A restore never deletes a file whose backup it cannot read.
- A journal exists for every restore that mutates the disk, and its state is monotonic except for an explicit rollback that turns `completed` into
  `rolled-back`.
