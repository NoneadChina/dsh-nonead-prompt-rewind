# Compatibility audit

> **Method: the tests are the audit.** The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts` and
> `tests/compat-tool-updates.test.ts`, together with `scripts/verify-host.mjs`, drive this
> plugin's real execution paths through the DSH subsystems' **real consumer paths** (the
> actual `@deepseek-ai/*` packages, not mocks) and assert the invariants below. A failing
> probe is a finding.
>
> **Retention rule.** Only two things are recorded: behaviour the harness could offer better
> and does not, or a defect this plugin must **not** compensate for. Correct-by-design
> behaviour is not restated — the probes pin it, and
> [Deliberate semantics](#deliberate-semantics-no-entry-kept) names it. Upstream references use
> symbols and file names, never line numbers: line numbers rot.
>
> **Declared range:** `engines.dsh: ">=0.2.1-0 <0.3.1-0"`, mirrored on all sixteen
> `@deepseek-ai/dsh-*` peer dependencies. **Verified baseline** (the targeted version):
> `0.2.2-alpha.3`, the version every `@deepseek-ai/*` devDependency is pinned to. Release and
> DSH alignment policy: [`docs/release/release.md`](../release/release.md).
>
> **Compatibility stance: adapt forward, never drop the range.** Moving the baseline forward
> does not narrow the declared range — `0.2.2-alpha.2` and the `0.2.1-0` line stay admitted.
> Forward adaptation and old-line support are one mechanism, not two: the new rules this plugin
> needs are read from the runtime (`caps`, the settings/config-form surfaces) and absent ones
> degrade, so the same code serves both the baseline and the lines below it.

## Verification method

The plugin carries no separate audit script. Verification is layered, and every layer runs
from `npm run check` (`typecheck` → `build` → `test` → `verify-host` → `npm pack --dry-run`):

| Layer | What it drives | Where |
| --- | --- | --- |
| Unit suites | Pure planning, the on-disk store, history, locales, client helpers | the 42 `tests/*.test.ts` files |
| Compatibility probes | Four consumer-facing probe suites — replayability, surface consistency, folds, compaction interop, client ordering, tool-update projection | `compat-invariants` · `compat-interop` · `compat-gaps` · `compat-tool-updates` |
| End-to-end host run | The real host plugin over a real `Session`, a real command registry and a fake fs: 17 numbered groups (command registration → surface cut → checkpoint capture → restore → crash/recovery → compaction → cleanup → plan mode) | `scripts/verify-host.mjs` |
| Publish layout | Bundle externals, export subpaths, tarball allowlist, engines/peer consistency | `tests/package-layout.test.ts` |
| Capability probe | Which Host/Client capabilities the installed DSH line actually ships | `scripts/probe-caps.mjs` |

The repository currently has **no `.github/workflows/`** directory, so `npm run check` is the
gate rather than a CI run. `scripts/probe-caps.mjs` is the deployment-side counterpart: it
reports `surfaceOp`, `rpc`, `toolsHooks`, `workspaceRegistry`, `settingsSection`,
`configForms` and `uiConversationViews`, and prints `REFUSE-ENABLE (core capability missing)`
when either core capability (`surfaceOp`, `rpc`) is absent.

## Version scope

`engines.dsh` is the **sole admission criterion** on current hosts: when a manifest declares
it, DSH reads no other range and admits the plugin only while the runtime satisfies it under
`includePrerelease`. Older hosts ignore `engines.dsh` and read the peer ranges instead, which
is why the two are kept identical. A runtime outside the declared range is refused at load
rather than admitted into unadapted code. The declaration is not the verification record,
which matters here because the declared range spans two lines:

- **`0.2.2-alpha.3` — verified baseline.** Every `@deepseek-ai/*` devDependency is pinned to
  this version, and `npm run check` runs against it. Every invariant below is asserted at this
  baseline.
- **`0.2.2-alpha.2` — previously verified, still admitted.** The same invariant set passed at
  `alpha.2` before the baseline moved; no invariant changed between the two patches, so the
  declared range keeps `alpha.2` admitted while the baseline follows the current patch.
- **`0.2.1-0` line — admitted, not verified version-by-version.** It predates the current
  client settings surface, so what exists there is decided at **runtime capability detection**,
  not by a version branch: the client asks the host over the `/dsh-rewind` `caps` endpoint and
  degrades what is absent (see [U9](#u9--the-capability-surface-differs-across-the-declared-range));
  `scripts/probe-caps.mjs` reports the same capability set before the plugin is even enabled.
  Core capabilities missing → the plugin refuses to be enabled; optional ones missing → the
  affected surface degrades and says so. The same detection covers the **`0.3.0` line**, which
  the range admits but no probe verifies (its packages were not available in the verification
  tree); the upper bound (`<0.3.1-0`) is where the next adaptation starts.

## Seams at the verified baseline

The plugin reads one channel's shape only — no legacy host face branch, no feature-detected
alternate API for the same seam.

| Seam | Implementation |
| --- | --- |
| Host session log | `session.snapshotEvents()` for planning; `session.append('user/message', …, { surfaceOp, sourceEventSeqs })` for the cut |
| Host working directory | `ctx.workingDirectory.ensure(agent)` — the base the fs tools resolve against |
| Host RPC channel | `ctx.connection.rpc.handle('/dsh-rewind', handler)`, registered from the root context |
| Client chat snapshot | the `uiConversation` `chat` view (`chatSnapshotOf`) |
| Client composer refill | the `conversation.input` facade's `setDraft` + `focus` |
| Client image restore | `SessionFace.readAttachment` (a complete durable reference), then `conversation.createDrafts(…, uploadImages)` + `input.for(scope).addAttachments(…)` |
| Client settings surfaces | the `plugins.bundle.config` card staged over `ctx.configForms.get(entryId)`, plus the `settings.section` page (`id: 'rewind'`, `order: 60`) with its `caps` query |
| Client seat-button DOM | structural locate of the copy-`<button>` container (`actionsContainerOf`) |
| File write-back | plain `node:fs` (`copyFile` / `writeFile` / `unlink`) with `fs/observed` re-sync (see [U5](#u5--no-supported-file-write-back-primitive)) |

## Definition of "fully compatible" (invariants)

| Invariant | Meaning | Probe |
|---|---|---|
| I1 log replayability | A rewound log passes token-meter `measure()` and the resume pre-flight `Session.create(id, events)` without throwing; `compaction/start` and `compaction/end` stay balanced | `compat-invariants` I1 (every scenario), `compat-tool-updates` I9b, `verify-host` 12/13 |
| I2 surface consistency | After a cut the surface has no duplicate nodes, every node exists in the log, the withdrawn target never returns, and `deriveMessages()` is legal; the marker is the surface tail | `compat-invariants` I2 |
| I3 step/turn structure | Client turn-tail ordering and one `step/start` per real step hold; every `step/end` and `assistant/message` has its `step/start`; the marker adds no step frame and no phantom turn | `compat-invariants` I3, `helpers.assertTurnTailOrdering` |
| I4 fold-service safety | Stats / title / goal / projection folds consume a marker-bearing log without throwing, with predictable values (no phantom turn, title event unchanged, admitted goal rounds intact) | `compat-invariants` I4, `compat-gaps` G1–G4 |
| I5 compaction interop | A tool call orphaned by a cancelled turn is pair-balanced once shadowed by a rewind; a target shadowed by a compaction checkpoint is refused with the plugin's own error; a post-rewind compaction stays legal; a pre-existing dangling `step/start` no longer breaks replay | `compat-interop` I5, `verify-host` 12/14 |
| I6 tool pipeline | Before-capture, disk commit and restore are correct for `write` / `edit`; a denied call never records; relative paths resolve against the session cwd; an over-cap file is never staged | `verify-host` 4–9, `tests/file-cap.test.ts` |
| I7 client ordering | A log carrying tool turns and rewind markers (a single `user/message` replace) satisfies the client builder's ordering, live and after resume | `compat-interop` I7 |
| I8 runtime safety | Rewind / compaction combinations never leave a dangling step/turn frame; a running agent is force-stopped first, and a cancel that never quiesces aborts the rewind | `verify-host` 8/9/13 |
| I9 tool-update projection | `Session.toolHistory()` folds the whole log, so a withdrawn `tool-addition` stays recorded; after a withdrawal no `tool-addition` / `tool-removal` block reaches the provider and the current declarations stay complete | `compat-tool-updates` I9 |

## Open items

Each item is a gap the plugin cannot close on its side, with the stance that keeps a future
fix pointed the right way. `U10` keeps its historic number because `src/index.ts` cites
`docs/compat/audit.md#u10`; the others are consecutive.

### U1 — a surface replacement must masquerade as a `user/message`

`assistant/message` is not a legal replacement carrier and no non-conversational surface type
exists, so the cut is a visible `user/message` whose content is the `(empty message)`
placeholder — a truly empty user message is rejected by strict OpenAI-compatible gateways.
**Ask:** a dedicated replacement/checkpoint surface event. **Stance:** no compensation; the
placeholder is deliberate, and both legacy marker shapes stay readable because a stored marker
is immutable (`src/index.ts`, `REWIND_MARKER_CONTENT`; pinned by `compat-invariants` I2).

### U2 — no per-message action slot for user / steering rows

The ↶ button is a React portal located **structurally** in the row's own `MessageIconActions`
container (`actionsContainerOf`); assistant rows have a declared actions slot, user and
steering rows have no counterpart. **Ask:** the symmetric slot, or published `data-chat-*`
anchors with a deprecation path. **Stance:** keep the portal; a locate miss degrades to "no
button", never a button on the wrong row. Pending-steering matching also keys on
`[data-message-attachments]`, which renders inside the user content factory and is still a
descendant of the row.

### U3 — client row visibility is not an extension input

The Chat builder already honours `visibility: 'hidden'`, but a plugin cannot feed that input
through a supported extension point: `definition.create()` is not one. **Workaround:** wrap the
registered `chat` view builder's `create()` and mark the rewind span `visibility: 'hidden'`
before the chat builder computes `order` (`src/client/visibility.ts`). Nodes stay in the store
for composer refill; there is no DOM hiding. The seam is private, so a harness refactor can
silently degrade the hide instead of failing a test.

### U4 — no in-process paged history read

Planning reads the whole log through `session.snapshotEvents()` (`src/index.ts`); there is no
in-process paged read, and a projection cannot answer the rewind question — "is this message
still on the surface?" is surface semantics, while projections fold the whole log.
**Stance:** read the log whole, no plugin-side index. **Ask:** an in-process paged read, or an
explicitly documented remote route.

### U5 — no supported file write-back primitive

A restore writes through plain `node:fs` because it must reach paths the fs service would
refuse as stale/absent. The host's observation/version layer cannot see that write, so the
next write of the same file would be judged against a stale observation (`FS_STALE_VERSION`).
The plugin re-emits the public `fs/observed` event to compensate
(`syncRestoreObservations`). **Ask:** a supported write-and-sync primitive. **Stance:** keep
the compensation — best-effort and per-file; it heals only the inconsistency the restore
itself created, never a later external edit.

### U6 — the attachment bytes behind a withdrawn message

The log is append-only, so withdrawing a message leaves its durable image references intact;
nothing reclaims attachment bytes. The client restores images into the composer by reading
those references (`readAttachment`) but has no delete path, and file blocks are deliberately
excluded — the harness exposes no client-side file-bytes loader, so a file is not restorable
(`src/client/hidden.ts`). **Stance:** no plugin-side reclamation and no guess; request an
upstream retention statement before adding one.

### U7 — command seam: focus policy and localized copy

Command *description* localization is a closed first-party allowlist, and no host command
*output* is localized for anyone, so this plugin carries its own host dictionary
(`src/locales.ts`) and renders command output through `translate()`. Its mode popover is its
own DOM with document capture-phase key handling (`src/client/index.ts`,
`src/client/confirm.ts`). **Ask:** a public localization channel for third-party command copy,
and a supported way to suppress the host's focus-restore after a menu selection. **Stance:**
no compensation beyond the own capture-phase panel and the own dictionary; the locale is read
through `settings.describe({ redactSecrets: true })` and degrades to English on any failure.

### U8 — peer ranges are not enforced at runtime

A nearer physical copy wins over a higher peer declaration, and a peer range is not a resolver
filter, so the `@deepseek-ai/schemastery` peer floor (`^3.18.6-alpha.1`) is the real
availability guarantee for the config schema: an older shadowing copy fails the top-level
`Config` evaluation before the plugin loads. **Stance:** keep the floor; never treat the range
as enforcement.

### U9 — the capability surface differs across the declared range

The declared range spans more than one line, and the surfaces this plugin mounts do not all
exist across it. The client asks the host over the `caps` endpoint
(`{ history, undo, fileCheckpointing }`) and shows `settings.caps.degraded` when one is false;
`scripts/probe-caps.mjs` reports the wider set (`surfaceOp`, `rpc`, `toolsHooks`,
`workspaceRegistry`, `settingsSection`, `configForms`, `uiConversationViews`). A narrower host
simply never calls the `settings.section` installer, so the page is a capability rather than a
hard dependency (`src/client/index.ts`). **Ask:** a stable, versioned capability negotiation
instead of probing package contents. **Stance:** capability detection plus degradation, never
a version branch; the core pair (`surfaceOp`, `rpc`) is non-negotiable and refuses enablement.

### U10 — generic RPC route registration fails from a plugin scope

`connection.rpc.handle` registers its route inside an effect that re-reads `owner.webServer`;
a plugin-scoped owner loses the `webServer` inject inside that effect. **Ask:** capture
`webServer` outside the effect so RPC registration works from a normal plugin scope.
**Stance:** register from the root context and dispose the route with the plugin
(`src/index.ts`); remove the shim when upstream fixes it.

## Coverage gaps

- **Real browser rendering replay.** The visibility wrapper's logic is covered in tests, but
  the rendered result is verified in a real engine manually, not in the suite. The host's Chat
  pagination behaviour around hidden rows is in the same bucket: observed in a live window,
  not probed here.
- **Workflow/jobs cancelled by a rewind.** Statically confirmed only; log-only `job/*` events
  carry the creating tool call and a termination cause, and no probe replays a real job.
- **Providers outside the verification dependencies.** Attachment storage is not a
  devDependency, so image refill is exercised with a fake face; real JSONL persistence needs a
  platform flock addon that the test tree does not carry.
- **Real Connection route registration.** `verify-host` calls the RPC handler directly, so the
  real `webServer` registration path is verified on a live host manually, not in the suite.

## Deliberate semantics (no entry kept)

Correct by design, named only so a future maintainer does not re-investigate: post-rewind
stats / telemetry fold the whole log; the title re-derives from the surface; a rewind leaves
`plan/mode` and the working directory alone; withdrawn content stays searchable and exportable
(the log is append-only, only the surface is cut); the bundle card's locale and icon are
declared by the plugin and read by the manager; the token-meter units fold an unmetered
surface `replace` at zero delta, so their figures do not roll back after a rewind (pinned by
`compat-gaps` G3/G4); and a rewind writes a history entry in its own workspace partition
(`<dsh home>/rewind-history/`, 10 per workspace), never as a restore source.

## See also
[Tracking boundary](tracking-boundary.md) · [Browser diagnostics](diagnostics.md) ·
[Harness reference](../harness-reference.md) · [Architecture](../architecture.md) · [Snapshot format](../format.md) · [Snapshot auto-cleanup](../snapshot-auto-cleanup.md)
