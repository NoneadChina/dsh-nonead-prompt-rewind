# File-rewind tracking boundary

> When it rewinds files, the plugin **writes back only content it actually backed up**. A file
> changed by a write-class tool (`write`, `edit`) can be restored exactly; a stretch of state
> that **was not backed up** makes the restore **incomplete** — the plugin prefers to do
> nothing rather than guess.
>
> The conversation half is separate and always available: a rewind appends one `user/message`
> marker whose `surfaceOp: replace` covers the target message and everything after it. The log
> is append-only and only the model-visible surface is cut, so no conversation content is ever
> deleted. File restore draws from the snapshot store and nothing else.

## 1. What gets restored

A restore can only ever write back a backup produced by one of the inputs below.

### 1.1 Before-write backups (`write` / `edit`)

When the model calls `write` or `edit`, the plugin captures the file's current content
**before** the change lands, at the `tools/execute` around-dispatch stage — after any approval
gate allowed the call, so an approved edit is still captured and a denied call records nothing.
The backup is committed to disk at `tools/post-execute`, under the seq of the user message that
anchored that turn. The path is the **resolved display path**, so a restore names the real file
however the model spelled the path. This path is deterministic: once the backup is committed,
the file is restorable.

### 1.2 External changes to tracked files, and the message-boundary rescan

A file joins a per-session **tracked set** the first time a write-class tool handles it. From
then on, every new user message makes the plugin re-check that set: if the file's current
on-disk state differs from its most recent recorded content, the current state is recorded as a
backup under the **new** message. This is the only entry point for an external edit — a shell
command, a build script, a hand edit in an editor — and it is why a rewind can recover a file
the model never touched with a tool but which the session had already tracked once.

That re-check **is** the message-boundary rescan. It runs asynchronously off the
`session/event` hot path, records only files that actually changed (an unchanged file writes
nothing), and is skipped while a rewind is in flight — the restore is writing those very files,
and a pass skipped then is re-derived at the next real boundary.

### 1.3 How a restore uses those backups

Per path, take the **earliest** backup anchored **at or after the target message**. When the
target has no backup of its own, look toward later messages for the earliest one. Then compare
it with the current disk:

- identical content (or still absent for a `null` backup) → **no-op**; repeated rewinds stay
  idempotent;
- different → write the recorded bytes back, or delete the file when the backup recorded that
  it did not exist (a creation).

Only actions that would actually change the disk are planned, so the confirmation preview and
the apply pass agree by construction.

## 2. What does not get restored

### 2.1 Files the session never handled with a tool

No backup exists, so no restore is possible — including every external edit of a file that
never entered the tracked set. See limitation 1.

### 2.2 Files over the size cap

A single regular file larger than **8 MiB** (the `maxFileBytes` config field; `0` disables the
cap) is not backed up. The capture path refuses it **before** reading the bytes, and the
message-boundary re-check skips it before comparing content. The refusal is a declared
limitation, not a delta scheme: this plugin is a lightweight conversation-scoped undo, not a
backup system, and copying a very large file on every edit is what grows the store without
bound and saturates disk IO. The cap has a second, safety-side effect: because a record only
ever exists for content under the cap, an over-cap file on disk means its recorded state
predates untracked edits. The restore planner therefore **refuses** such a path and reports it
in the result instead of writing older, smaller content over the larger live file. If the file
is currently over the cap, **no** rewind touches it.

### 2.3 Subagent sessions

A subagent runs its own session, and that session is never a rewind target: the host refuses
generic session RPCs for a subagent-owned identity, so a backup recorded under a child session
id could never be restored by any rewind — parent or child — and would only leak on disk. One
predicate (`isSubagentSession`: `header.origin === 'subagent'` or `delegationDepth > 0`) gates
every skip site: before-capture, the boundary re-check, the `agent/created` reconcile and the
lazy cleanup trigger. The parent session's own view of the work (the subagent tool call and its
result) still rewinds with the parent.

### 2.4 Symlinks, hard links, and moved parents

A path whose **final component** is a symlink or a hard link (`lstat().nlink > 1`) is never
planned and never written through — it is reported as skipped. A symlink would redirect the
write outside the checkpoint, and a hard link would clobber every other name for the same
inode. The same rule is applied list-side, so a linked path is not even re-checked.

Symlinked **ancestor directories** are treated differently: the entry records the parent's
`realpath` at checkpoint time, and a restore refuses the path when its parent no longer
resolves there — a stable symlinked workspace root resolves identically on both sides and is
never a false skip. A repointed or moved ancestor is therefore covered too: the path is
skipped, never written into a guessed location, and a missing parent chain is recreated only
while the nearest surviving ancestor still resolves inside the pinned location.

### 2.5 Paths outside the record, and legacy lossy records

The restore is not a workspace scan: it reads no directory listing, follows no wildcard, and
infers no path. The action set is exactly the recorded display paths that the planner
reconciled against the disk. A file outside that set is untouched, even if it changed in the
same turn. A record written by an older build that decoded non-UTF-8 bytes lossily contains
replacement characters; the original bytes are unknowable. Such a record is comparable against
the disk but is **never written back** — a skip is reported instead of destroying live bytes
with lossy content.

## 3. How the record is shaped

### 3.1 One backup = the state when one message began

The plugin does not store the workspace's current state; it stores **state transitions**. Every
backup answers one question: *what was this file when that message began?* Its content has two
forms: `null` means the file **did not exist** (a restore deletes it), otherwise it is a full
byte copy. Together these backups are the session's **snapshot**, grouped by message.

Within one message's turn, every write-class call leaves a backup of its own; a restore takes
the **earliest** of them, which is exactly the state the message began with. Backups are raw
byte sidecars (`copyFile`), never decoded strings, so binary and non-UTF-8 files round-trip
byte-exactly. Permission bits are recorded alongside, applied only when the content is
restored, and never decide whether a restore happens; identical consecutive content is stored
as an in-place dedup link instead of a second copy.

### 3.2 Cases that produce no backup

- **Unchanged, not stored** — the boundary re-check finds the disk identical to the latest
  record and writes nothing. A message that changed no file therefore has no backup of its own.
- **Over the cap, not stored** — see 2.2.
- **Snapshot backups turned off** — while `fileCheckpointingEnabled` is false, neither the
  before-write capture nor the boundary re-check records anything; after it is turned back on,
  the off period remains a gap.

## 4. An example

| Msg | In the turn | File content | Backup: what it was when that message began |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` (backed up before the write; the file joins tracking) |
| 2 | — | `A` | `A` (the disk differs from the previous backup `null`) |
| 3 | — | `A` | (none: identical to the latest backup, nothing edited this turn) |
| 4 | `edit` | `A` → `B` | `A` (the content before that edit) |
| 5 | `bash` rewrite | `B` → `C` | `B` (msg 4's edit had landed before msg 5 arrived) |

The disk now holds `C`. Rewinding gives: target 1 → `null`, the file is deleted; target 2 →
`A`; target 3 → no backup of its own, so the earliest later one is msg 4's `A`; target 4 and
target 5 → `A` and `B` respectively.

## 5. Known limitations

Both limitations share one root cause: **a stretch of state was not backed up**. Limitation 1
ends in **no restore at all**; limitation 2 in an **incomplete restore**.

### 5.1 Limitation 1 — history that never entered tracking

Being handled by a write-class tool is the prerequisite for a file to join the tracked set.
Before that, every external edit has no backup. If nothing in the session ever handled it,
rewinding reports "no restorable changes" at every target. If something handled it later (the
common case), backups exist only from that moment on:

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | — | `v0` | (none: not tracked yet) |
| 2 | a manual edit | `v0` → `v1` | (none) |
| 3 | a manual edit | `v1` → `v2` | (none) |
| 4 | `edit`, the first touch | `v2` → `v3` | `v2` (before-write; tracking starts here) |
| 5 | — | `v3` | `v3` (differs from `v2`) |

Rewinding to msg 5 → `v3`; to msg 4 → `v2`; and **rewinding to msg 1, 2 or 3 also gives
`v2`** — the earliest backup after them is msg 4's. `v2` really is the content when the file was
first handled, but those three messages began from `v0`, `v0` and `v1`; the plugin never saw
them.

### 5.2 Limitation 2 — an incomplete restore

"Unchanged, not stored", "over the cap, not stored" and turning backups off all leave a stretch
of state unrecorded. When the target has no backup of its own, the plugin looks toward later
messages; once an **unrecorded change** sits between them, what it takes is no longer that state.

**Case 1 — the change does not belong to any message yet**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | — | `A` | `A` |
| 3 | — | `A` | (none: identical to the latest backup) |
| (after) | a manual edit | `A` → `X` | (none: no message has claimed it yet) |

Rewinding to msg 3: neither it nor anything later has a backup, and the plugin cannot know the
file changed, so it **does nothing and the file stays at `X`**. To recover `A`, rewind to msg 2.

**Case 2 — what is recorded is the state after the change**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | — | `A` | `A` |
| 3 | — | `A` | (none) |
| 4 | a command changes it to `B` | `A` → `B` | (none: the disk was still `A` on arrival) |
| 5 | — | `B` | `B` (differs from `A`) |

Rewinding to msg 3 or 4 finds msg 5's `B` — the state **after** the change, while they began
with `A`. The disk already matches, so nothing happens; if the file changed again later, the
plugin would write `B` over newer content. Had msg 4's command **deleted** the file, msg 5's
backup would be `null` and rewinding to 3 or 4 would **delete the current file**.

**Case 3 — the file exceeded the cap while it changed**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | the edit grows it past the cap | `A` → `G1` | `A` |
| 3 | a tool or external edit | `G1` → `G2` | (none: over the cap) |
| 4 | shrinks back to `B` | `G2` → `B` | (none: still over the cap on arrival) |
| 5 | `edit` | `B` → `X` | `B` (tracking resumes) |

The stretch over the cap is a **coverage gap**. Rewinding to msg 3 or 4 finds msg 5's `B` and
writes it; the "big" state can never be restored.

**Case 4 — backups were off and back on**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | `edit` | `A` → `B` | (none: backups were off) |
| 3 | `edit` | `B` → `C` | `B` (back on) |

Changes made while backups were off are not in the record, so a rewind across that period may be
incomplete: for msg 2 the earliest later backup is msg 3's `B`.

## 6. Caps and failure handling

| Bound / failure | Behaviour |
| --- | --- |
| Per-file size cap | Default 8 MiB (`maxFileBytes`, `0` = unlimited). Over-cap files are neither staged nor re-checked, and an over-cap file on disk is refused at restore time with a "not restored: … over the limit" line |
| Per-session groups | The newest **100** message groups are kept; older groups are pruned. A group a non-terminal restore journal still references is pinned until that op is resolved |
| Snapshot root | `<dsh home>/rewind-snapshots/` by default (config `snapshotDir` wins; `config.dshHome` > `$DSH_HOME` > `~/.dsh`) |
| Backups disabled | No new records; the restore may be incomplete and the result says so (`snapshot backups are off, so the restore may be incomplete`) |
| Newer store format | Whole-operation fail-closed: no restore, no clear, nothing changed (`file restore unavailable: … newer store format`); the conversation rewind itself still succeeds |
| Per-file failure | The pass never aborts: the failure is reported per path in the result, and the other paths still restore |
| Crash mid-restore | A journal records intent and the pre-restore ("rescue") state before any mutation; after a restart the op can be continued or rolled back, and the disk is the authority for what was already applied |
| Unverifiable parent | Skipped and reported; never written into a location that cannot be verified |

## 7. Why these limitations are accepted

Removing **limitation 1** would require knowing which files an arbitrary command or external
edit touched. Neither route works: every external writer would have to declare itself (`sed`,
build scripts and editors will not), or the plugin would have to track the whole workspace and
snapshot the tree before every change — enormous in volume, and precise workspace-level history
is exactly what Git is for. This plugin does lightweight rewinding aimed at agent tooling.
Removing **limitation 2** would mean giving up "unchanged, not stored" and "over the cap, not
stored": every message boundary would record **every** tracked file, and large files would be
copied in full again and again. Storage would grow linearly with the conversation, and every
backup reads and writes a whole file, so a large one saturates disk IO — which is why the
per-file cap exists. What the two limitations buy is lightweight, predictable behaviour that
**only ever writes back content it actually backed up**. For precise workspace-level history,
use Git.

## See also
[SECURITY.md](../../SECURITY.md) · [Snapshot auto-cleanup](../snapshot-auto-cleanup.md) ·
[Compatibility audit](audit.md) · [Snapshot format](../format.md)
