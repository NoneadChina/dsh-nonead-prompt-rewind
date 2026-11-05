# Architecture
> Maintainer document. It describes how the two faces of `dsh-nonead-prompt-rewind`
> are wired: packaging, module layering, the rewind and snapshot pipelines, the
> history/settings data flow, the RPC surface, and the compatibility strategy. The
> module inventory and commands live in [AGENTS.md](../AGENTS.md); durable formats in
> [format.md](format.md); the security model in [SECURITY.md](../SECURITY.md); the DSH
> interfaces in [harness-reference.md](harness-reference.md). This file covers the
> connections between those pieces, not their contents.
## 1. Scope
The plugin does one thing: rewind the conversation **in place** to an earlier user message
by appending a marker to the session log, then restore the workspace files the same rewind
covers. Two properties shape every decision:

- **Append-only.** The log is never rewritten. A rewind is one appended `user/message`
  whose surface operation replaces the target and every surface node after it; raw history
  stays intact for audit, search and export.
- **Two independent halves.** The conversation half works when snapshots are off,
  unavailable, or written by a newer build. The file half never changes a rewind's
  conversation outcome.
## 2. Dual-face packaging
One npm package exports two plugin faces: the host face in the DSH node process and the
client face in the browser bundle.
### 2.1 Host face
`src/index.ts` is the only module that touches the cordis `Context`. It declares
`name = 'dsh-rewind'` and `inject = ['commands', 'tools', 'settings']`, and `apply()`
registers four commands (`/rewind`, alias `/undo`, the internal engine channel
`prompt-rewind`, `/snapshot-auto-cleanup`), the checkpoint pipeline on `tools/execute` /
`tools/post-execute` / `tools/result`, the message-boundary re-check on `session/event`,
the session-format guard on `agent/created`, the RPC channel `/dsh-rewind`, and the
snapshot, history and cleanup-policy stores. The host face is the **only** writer of
snapshots and history; the client never reads those directories.
### 2.2 Client face
`src/client/index.ts` declares
`inject = ['slots', 'sessions', 'locale', 'commandUi', 'configForms', 'connection']` and
renders the user-visible surfaces: the `conversation.session.header.actions` registration
that mounts the message-scoped portal bridge (`portals.tsx` — the ↶ button and popover), a
`settings.section` registration (`id: 'rewind'`, `order: 60`) for the Rewind History page
plus the matching `settings.section.icon` glyph (same id: a return arrow that loops
back on itself, so the nav row is not the shell's neutral default),
a `plugins.bundle.config` registration keyed by the package name for the configuration
card, the locale dictionaries, the injected stylesheet, the Chat-view visibility wrapper,
and the `/rewind` command decoration. The faces share **no module**: they meet at the
`/dsh-rewind` RPC channel, the `prompt-rewind` engine command, and the `surfaceOp` marker
already in the log.
### 2.3 Bundle row and build output
[cordis.patch.yml](../cordis.patch.yml) inserts one row whose `name` must equal the package
name — the client-modules node half resolves `require.resolve('<row-name>/package.json')`
to find the package, then the client half through the `./client` export declared under
`dsh.client`:

```yaml
- insert:
    - id: dsh-nonead-prompt-rewind
      name: 'dsh-nonead-prompt-rewind'
```
`package.json` declares `dsh.bundle.patch`, `dsh.client.inject` (the five
`@deepseek-ai/dsh-client-*` packages the client consumes) and `dsh.client.platform: web`.
`scripts/build.mjs` emits `lib/index.js` (host ESM; every `@deepseek-ai/*` import stays
**external** for the DSH installation), `lib/client.js` (client bundled to CJS and wrapped
in `window.__ModuleLoader__.load({ id, factory })`) and `lib/types/**`; `exports['.']` and
`exports['./client']` point at the two bundles, and `prepack` runs the build so a tarball
always carries both faces.
## 3. Module layering and dependency rules
```text
marker.ts, locales.ts            producer identity + copy dictionaries (no cordis)
rewind.ts                        pure planning: parse, candidates, plan the cut
snapshot.ts                      checkpoint store: capture, commit, plan, restore, journal, prune
history.ts, snapshot-cleanup.ts  fs-only policy stores (audit trail; cleanup policy + sweep)
index.ts                         host wiring: cordis context, commands, tool hooks, RPC
client/*                         browser wiring: slots, portals, dialogs, settings, visibility
```
Four rules keep the layers testable and replaceable:

1. **`rewind.ts` is pure.** No I/O and no `Session` object: `planRewind`,
   `listRewindCandidates` and `parseRewindTarget` derive everything from the event log and
   ordered surface. The client computes candidates by the same rules (`candidates.ts`), but
   the host re-plans when the command runs — the client is never trusted for the cut.
2. **`snapshot.ts` is host-independent.** It imports only `node:fs/promises`, `node:crypto`,
   `node:path` and the pure `resolveDshHome` helper — never cordis, `Agent` or `Session`.
   Filesystem decisions go through injected seams (`DiskProbe`, `DeleteFile`, a test-only
   `crash` hook), so the store runs against a fake filesystem in tests.
3. **Policy stores are ports, not services.** `history.ts` and `snapshot-cleanup.ts` expose
   plain classes/functions over a root path and a config writer; `index.ts` is their only
   consumer, keeping them unit-testable without a host.
4. **The client derives state from host channels.** Impact, candidates and history come from
   RPC. The DOM is used only for what only the DOM knows: locating a message row's action
   container, writing the composer draft, and reading pending steering bubbles.
## 4. Rewind pipeline
```text
↶ button (portals.tsx)                       /rewind [<index> | @<seq>]   (alias /undo)
  → confirm dialog, impact via RPC             → decoration: a bare call opens the harness
  → on confirm: /prompt-rewind @<seq>            popupSelect; a picked row runs the engine form
```
`handleRewind` enforces a per-session in-flight guard, then does the same work for every caller:

1. **Resolve the target.** `parseRewindTarget` accepts `@<seq>` (absolute log seq) or a 1-based
   recency index. `planRewind` requires a **human** user message (`data.source.kind === 'user'`)
   still on the surface; injected context and compaction checkpoints ride `user/message` with
   another source and are refused, as is a target already shadowed by compaction.
2. **Stop the running turn.** A non-idle agent is cancelled with
   `agent.cancel({ kind: 'user' }, { keepInbox: true })` and the handler waits for quiescence;
   a failed stop aborts with `stop-failed`. Pending `next-step` steering is then dropped (it
   belongs to the future being rolled back); queued next-turn messages stay because the queue
   dock already offers per-item edit/remove.
3. **Append the marker.** One `session.append('user/message', marker, …)` with
   `surfaceOp: { op: 'replace', startSeq, endSeq }` covering the target and every surface node
   after it, plus `sourceEventSeqs` naming the shadowed seqs. Content is the constant
   `(empty message)` placeholder; the source is the producer-owned `{ kind: 'dsh-rewind' }`. It
   is appended while idle, outside a turn, so no step frame is needed.
4. **Restore files.** `store.restoreAfter(targetSeq, unlink, undefined, { opId })` runs
   unconditionally — there is no mode selection. The `opId` is shared with the history entry,
   so the page can address the journal later. Afterwards `syncRestoreObservations(ctx, fs, agent,
   outcome)` re-syncs the harness's file observation so the next write of a restored/deleted
   path is not judged against a stale state.
5. **Record and report.** `recordHistoryEntry` is awaited (a few KB, atomic rename) so a client
   reading history right after the rewind sees its entry; a history failure is swallowed and
   never surfaces as a rewind failure. The result carries the target seq plus
   restored/deleted/skipped/failed counts as human copy the client never parses.

The client completes the visible half:

- `visibility.ts` wraps the registered `chat` view builder and marks the nodes in the
  executed rewind's `[target, marker]` span `visibility: 'hidden'`. Hidden nodes stay in the
  node store — so the composer can still read their text and image references — but leave
  `order`, locations, turn navigation and grouping.
- `runRewindAndFill` re-reads the target and refills **that session's** composer
  (`conversation.input.for(scope).setDraft` first, DOM `[data-composer-input]` fallback). It
  refuses to overwrite a non-empty draft, skips the refill when the user switched sessions,
  and re-attaches durable image references when the attachment services are available.

Invariants: the marker is the only log mutation of the conversation half; repeated rewinds
are idempotent because restore actions are reconciled against the live disk (a target whose
state already matches plans zero actions); an unsupported trailing argument is rejected
loudly, so a stale caller cannot believe only part of the action ran.
## 5. Snapshot pipeline
The store persists "before-backup per tracked mutation, grouped by message" under
`<dsh home>/rewind-snapshots/`:

```text
tools/execute        captureBefore: for write/edit only, resolve the path, stat it, enforce
                     the per-file cap, then stage a RAW BYTE copy in .pending/ (never through
                     a decoded string). Subagent sessions are skipped — their edits can never
                     be restored, so tracking would only leak bytes.
tools/post-execute   commitEntry: failed calls drop their capture; otherwise the anchor is the
                     latest user/message seq (incrementally cached) and recordBackup moves the
                     staged bytes into <sessionId>/<anchorSeq>/ next to the entry JSON.
tools/result         safety net: a throw in another tools/execute wrapper can skip post-execute,
                     so any capture still pending is discarded here.
session/event        reconcileTracked: at every user-message boundary, re-stat every tracked path
(user/message)       and record a full before-backup for each whose disk state changed — external
                     edits and deletions enter the record this way. Skipped while a rewind is in
                     flight. agent/created: setFormatVersion, assertKnownStoreVersion (a newer
                     store disables file restore for that session), reconcileFormatVersion (a
                     different session format clears that session's snapshot directory).
```
Storage is bounded four ways: a regular file over the per-file cap (default 8 MiB;
`maxFileBytes: 0` disables it) is never backed up; content-identical before-states become dedup
links instead of second copies; `prune` keeps the newest 100 anchor groups per session and
materializes a surviving link pointing into a group being dropped; the optional age-based sweep
removes whole long-inactive session directories — except a directory that still holds a
non-terminal (or unclassifiable) restore journal, or one written by a newer store version: both
are recovery data this build must not destroy. A non-terminal restore journal pins the groups
its actions reference, so an interrupted op stays continuable. Exact numbers and fields are in
[format.md](format.md).

Restore is journaled rather than best-effort: `planRestore` reconciles the earliest entry per
path (at/after the target) with the current disk and plans only actions that would change it;
`beginRestore` captures the pre-restore ("rescue") bytes of every planned path and persists the
intent journal **before** the first filesystem mutation; actions apply one at a time, a per-file
failure is recorded and never aborts the pass, and deleting an already-absent file is a no-op.
A failure-free pass ends `completed`; otherwise the journal stays open — `reconcileRestores`
reports where an interrupted op stopped, `continueRestore` finishes it, `rollbackRestore`
returns to the exact pre-restore state, and `undoRestore` is the user-facing "undo this rewind"
(completed journals only).
## 6. History and the Settings page
History is an audit trail, never a restore source:

```text
executeRewind ──append(entry)──▶ HistoryStore ──▶ <dsh home>/rewind-history/<workspaceKey>/history.json
                                      ▲
settings page (settings.section id 'rewind') ──RPC history / history.clear / undo / caps──┘
```
- The **partition key is resolved host-side** from the active session: the host reverse-looks
  the session id up in the workspace registry and uses `ws-<workspaceId>`; a session the
  registry does not account for lands in `_unknown`. The client never supplies a key, so
  cross-workspace reads are impossible by construction.
- Each partition keeps the newest `historyLimit` entries (default 10), written through a
  per-path serial queue with tmp+rename; a corrupt file is renamed aside and replaced, never
  silently deleted.
- The **undo RPC** accepts a completed journal for the active session's **chain tail** only,
  refuses an already-undone entry, verifies every applied path still matches its post-restore
  state, and rejects the whole batch with `stale-undo` (listing the paths) when the user
  edited a file after the rewind. Success patches `undoneAt` / `undoOutcome` / `undoMode`;
  undo restores **files only** because the conversation nodes were removed from the surface.
- `history.clear` deletes records only. The Rewind History page renders the SAME
  `SettingsCard` as the Plugins page over one shared settings form model, so both sites edit
  one draft.
## 7. RPC surface
The host registers one channel, `/dsh-rewind`, and dispatches by endpoint. Every payload must
carry a non-empty `sessionId`; the handler resolves the live agent from the agent registry and
fails closed when it is absent.

| Endpoint | Payload | Value | Notes |
| --- | --- | --- | --- |
| `preview` | `{ sessionId, seq }` | `{ files, uncovered, backupOff }` | restore/delete impact; `uncovered` = recorded paths over the cap; `backupOff` = new backups disabled |
| `candidates` | `{ sessionId }` | `{ candidates }` | human user messages on the surface, newest first |
| `history` | `{ sessionId }` | `{ workspace, entries }` | partition derived host-side |
| `history.clear` | `{ sessionId }` | `{ cleared }` | records only |
| `undo` | `{ sessionId, opId }` | `{ kind: 'ok' \| 'partial', restored, deleted, failed }` | chain tail, once per entry, files only |
| `caps` | `{ sessionId }` | `{ history, undo, fileCheckpointing }` | what THIS host provides |

Failures use a stable `{ ok: false, error: { code, message, details } }` envelope; codes are
`rewind/bad-request`, `rewind/agents-unavailable`, `rewind/session-not-found`,
`rewind/unknown-entry`, `rewind/undo-cross-workspace`, `rewind/undo-other-session`,
`rewind/already-undone`, `rewind/not-undoable`, `rewind/undo-not-top`, `rewind/stale-undo`,
`rewind/undo-failed`, `rewind/unknown-endpoint` and `rewind/failed`. The channel is registered
from the root context (`ctx.inject(['connection'])`) because `rpc.handle` re-reads the owner's
web server when it runs; disposal is tied to the plugin's fiber. Without a connection service
the plugin still rewinds by command — only the graphical surfaces degrade.
## 8. Compatibility strategy
- **Admission boundary.** `engines.node` is `>=24.9.0` and `engines.dsh` is `>=0.2.1-0 <0.3.1-0`;
  every `@deepseek-ai/dsh-*` peer uses the same range and is optional. A runtime outside the range
  is refused at load rather than admitted into unadapted code. `devDependencies` pin
  `0.2.2-alpha.3`, the verified line; the range below it stays admitted because optional
  surfaces are read through the runtime `caps` probe rather than a version branch.
- **Runtime capability probe.** `caps` reports `history`, `undo` and `fileCheckpointing`; the
  settings page states a missing capability instead of hiding the loss.
- **Optional seams degrade, they do not break the feature.** Each command registration is
  isolated, so a name owned by another plugin costs only that name. A missing `settings` entry
  makes the cleanup policy fail closed (reads report "unavailable", a sweep deletes nothing). A
  missing `fs` / `workingDirectory` scope disables new captures and the post-restore observation
  sync while the conversation rewind keeps working; a missing slot removes one UI surface only.
- **Unknown store versions fail closed.** Snapshots whose store marker or entry value is newer
  than this build understands refuse **file** restore, clear and new entries; the conversation
  rewind, which does not depend on snapshots, succeeds.
- **Session-format migrations are guarded.** Snapshots are anchored by log seq, so when DSH's
  session format changes the plugin clears that session's snapshot directory instead of
  re-mapping seq references.
- **Tests are the audit.** `tests/compat-*.test.ts` drive the targeted DSH line's real consumer
  paths and pin the invariants; `scripts/verify-host.mjs` boots the built host half on a real
  cordis context and drives rewind plus checkpoint end to end; `scripts/probe-caps.mjs` reports
  what an installed DSH line ships. Findings live in [compat/audit.md](compat/audit.md).
- **No cross-line promise.** The declared range is the admission boundary, but `main` always
  adapts to the latest DSH line; a shipped line is preserved on its release branch (see
  [release/release.md](release/release.md)).
## 9. Related reading
[format.md](format.md) (every durable file, field by field) ·
[harness-reference.md](harness-reference.md) (DSH subsystems and seams) ·
[compat/tracking-boundary.md](compat/tracking-boundary.md) (which files a rewind can restore) ·
[compat/diagnostics.md](compat/diagnostics.md) (browser diagnostics) ·
[snapshot-auto-cleanup.md](snapshot-auto-cleanup.md) (cleanup command and policy) ·
[DEVELOPMENT-GUIDE.zh.md](DEVELOPMENT-GUIDE.zh.md) (Chinese maintainer handbook).
