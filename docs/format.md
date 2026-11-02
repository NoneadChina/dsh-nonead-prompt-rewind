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
└── <sessionId>/
    ├── store                                  # plugin store-format marker ("2")
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
| `store` | decimal integer (`2`) | On-disk format the store writes. Missing means the legacy string format. |
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
  store: 2            // on-disk format; absent or 1 = the legacy string format
  callId: string      // the tool call that mutated the file
  file: string        // resolved display path (absolute) of the tracked file
  parent?: string     // realpath of dirname(file) at commit time (the location pin)
  blob: string | null // sidecar file name; null = the file did not exist (a creation)
  size: number        // byte length of the sidecar (0 when blob is null)
  mode?: number       // permission bits recorded at capture time (best effort)
  lossy?: true        // recorded from legacy content that had already lost bytes
  time: number        // epoch ms; strictly increasing within one store instance
}
```
Semantics a reader may rely on:

- **`blob` is the pre-edit state.** A string names the sidecar holding the exact before bytes, copied raw (never decoded into a JS string), so binary
  and non-UTF-8 files round-trip byte-exactly. The name is an invariant: it must equal this entry's own file name with `.json` replaced by `.before`.
  A sidecar that is missing, not a regular file, or a different size than `size` is an integrity failure — never a silent "the file was created".
- **Size cap.** A regular file larger than `DEFAULT_MAX_FILE_BYTES` (8 MiB) is not backed up;
  the cap is exposed as `maxFileBytes`, where `0` disables it. The capture is skipped entirely
  — never recorded as a creation, which a rewind would turn into a delete.
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
## 6. Dedup link entry
When a tracked file's new before-state is byte-identical to its immediately-prior entry,
the entry is stored as a link instead of a second copy:

```ts
interface LinkEntryJson {
  store: 2
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
## 7. Restore journal
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
  done: boolean                 // the fs op completed and was marked
  failed?: string               // per-action failure message (the pass never aborts)
}
```
A `{blob}` ref is session-relative and validated on both write and read, so a corrupt or
hostile journal cannot point a restore or rollback outside the session directory. It
names either an entry sidecar (`<anchorSeq>/<callId-base>.before`) or a rescue copy
(`rescue/<opId>/<n>.before`). `{text}` refs carry content with no sidecar: a legacy
entry's inline string, or a legacy journal's inline strings.
State machine: `running` and `rollback-running` are non-terminal; `completed` and
`rolled-back` are terminal. Reconciliation reports a still non-terminal op as
`interrupted`, and a `recovery-required` op when a rollback could not complete or the
journal is corrupt; the journal's own `state` stays non-terminal in both cases. A journal
read from a legacy-prefix file is rewritten in place (same file) as `version: 2` when a
redo or rollback completes, so one op never leaves two divergent versions on disk.
## 8. Rewind history partition
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
## 9. Cleanup state file
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
## 10. Write and recovery guarantees
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
  those directories; it also recycles terminal journals with their `rescue/<opId>/` bytes and collects `.pending/` captures older than 24 h. A group a
  non-terminal journal still references is pinned, so the effective window may exceed the cap until that op is resolved. Non-terminal and corrupt
  journals are always kept.
## 11. Validation and failure policy
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
## 12. Versioning policy
The format is versioned at three levels, and compatibility means *reading old data*, not
repairing it:

- A session-level `store` marker and a self-describing `store` field on every entry. A missing marker (or `1`) is the legacy string format, which is
  still read but never migrated. A value **above** the current `CURRENT_STORE_VERSION` (`2`) fails the whole operation closed: no file restore, no
  clear, no new entry written into a store a newer build owns. The conversation rewind does not depend on snapshots and keeps working.
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
## 13. Format invariants
- Every path a reader follows is either rooted in the store root or explicitly validated as a session-relative, single-level reference.
- An entry's sidecar is named after the entry, sits beside it, and holds the exact bytes it claims (`size` matches).
- `anchorSeq` comes from the directory, never from the JSON body.
- A restore never deletes a file whose backup it cannot read.
- A journal exists for every restore that mutates the disk, and its state is monotonic except for an explicit rollback that turns `completed` into
  `rolled-back`.
