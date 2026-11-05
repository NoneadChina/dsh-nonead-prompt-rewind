# DeepSeek Harness interface reference

> Maintainer reference for the DSH subsystems this plugin builds on, the exact
> seams it consumes, and the current source layout of the plugin itself. Upstream
> project: [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
> The plugin's own architecture is in [architecture.md](architecture.md); durable
> formats are in [format.md](format.md).

## 1. Subsystems

| Subsystem | What this plugin uses it for | Upstream reference |
| --- | --- | --- |
| Session | Append the rewind marker, read `snapshotEvents()`, `surface.nodes`, `header.version`, `surfaceOp` / `sourceEventSeqs` | [docs/subsystems/session.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md) · [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/index.ts) |
| Core / Agent | `agent.status`, `agent.session`, `agent.cancel()`, quiescence | [docs/subsystems/core.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/core.md) · [packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent/src/runtime-types.ts) |
| Commands | `ctx.commands.register()` for `/rewind`, `/undo`, `prompt-rewind`, `/snapshot-auto-cleanup` | [docs/subsystems/commands.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/commands.md) · [packages/interaction/commands/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/interaction/commands/src/index.ts) |
| Tools | `tools/execute` around-dispatch capture, `tools/post-execute` commit, `tools/result` cleanup | [docs/subsystems/tools.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/tools.md) · [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/tools/src/index.ts) |
| Surface / session query | `foldSurface` semantics behind the ordered surface and the candidate list | [docs/subsystems/session-query.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-query.md) · [packages/core/session/src/surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/surface.ts) |
| Compaction | Rewind/compact interop: a target shadowed by a compaction checkpoint is refused | [docs/subsystems/compaction.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/compaction.md) |
| Message construction | `createUserMessage`, `MessageSourceMap` (the marker's `{ kind: 'dsh-rewind' }` source) | [packages/llm/llm/src/message.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/llm/llm/src/message.ts) |
| Client session face | `command`, `cancel`, `readAttachment(ImageAttachmentRef)` behind the composer refill | [packages/api/session-controller/src/client/contract/session.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/api/session-controller/src/client/contract/session.ts) |
| Client chat rendering | Message row anchors and the `MessageIconActions` container the ↶ portal attaches to | [packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) · [MessageItem.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/MessageItem.tsx) |
| Client pending interaction | Pending steering rows matched to inbox `next-step` entries | [packages/client/ui-session/src/client/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-session/src/client/index.ts) |

Also in the harness repository's `docs/`: `persistence-catalog.md` (full `SessionEventMap`),
`tool-catalog.md` (tool inventory) and `config-catalog.md` (configuration inventory).
Host services without a public doc page (settings, connection RPC, client slots, locale,
commands UI) are exercised directly by the compatibility suites; the seam-by-seam audit is
in [compat/audit.md](compat/audit.md).

## 2. Seams this plugin consumes

| Seam | Use in this plugin |
| --- | --- |
| `session.append('user/message', …)` | The one and only log mutation of a rewind (marker + `surfaceOp.replace`) |
| `session.snapshotEvents()` / `session.surface.nodes` | Pure planning input (`rewind.ts`), candidate listing, turn anchor |
| `agent.cancel({ kind: 'user' }, { keepInbox: true })` | Stop a running turn before the surface is cut |
| `ctx.commands.register()` | Four command registrations, each isolated so a name conflict costs one name |
| `tools/execute` / `tools/post-execute` / `tools/result` | Before-capture, commit, and pending-capture cleanup |
| `session/event` (`user/message`) | Message-boundary re-check of tracked files |
| `agent/created` | Session-format guard + store-version check |
| `ctx.connection.rpc.handle('/dsh-rewind', …)` | Browser channel: `preview`, `candidates`, `history`, `history.clear`, `undo`, `caps` |
| `ctx.settings` / `configForms` | Config schema, cleanup policy writes, one shared settings form model |
| `conversation.input.for(scope).setDraft()` | Primary composer refill channel (DOM `[data-composer-input]` is the fallback) |
| `uiConversation` chat view | Chat snapshot for visibility, candidates, the ↶ button, pending rows |
| `SessionFace.readAttachment()` + `conversation.createDrafts()` | Restoring durable image references into the composer |
| `fs` + `workingDirectory` | Path resolution and `stat` fence for captures; post-restore observation sync |

## 3. Plugin source layout

Host face — `src/`, seven files:

| File | Responsibility |
| --- | --- |
| `index.ts` | The only cordis wiring layer: commands, tool hooks, session events, RPC, store construction, config schema |
| `rewind.ts` | Pure planning: target parsing, candidate listing, surface-range computation, typed errors |
| `snapshot.ts` | Checkpoint store: staged captures, commits, dedup links, restore planning, journals, prune, stale sweep |
| `history.ts` | Rewind audit trail: per-workspace partitions, atomic writes, chain helpers, corrupt-file recovery |
| `snapshot-cleanup.ts` | Cleanup policy adapter, `/snapshot-auto-cleanup` argument grammar, auto-sweep throttle, last-sweep state |
| `locales.ts` | Host-side command copy for the eight interface languages |
| `marker.ts` | Producer-owned marker source identity (`{ kind: 'dsh-rewind' }`) |

Client face — `src/client/`, fourteen files:

| File | Responsibility |
| --- | --- |
| `index.ts` | Client entry: locale registration, stylesheet, chat visibility, portal bridge, settings card/page, `/rewind` decoration |
| `portals.tsx` | The per-message ↶ button, its popover, `runRewindAndFill` (command + composer refill), pending retract |
| `confirm.ts` | Single-stage confirmation dialog (DOM): impact list, one confirm, Esc / ⌘/Ctrl+Enter |
| `host-rpc.ts` | Typed browser half of `/dsh-rewind`: `preview`, `candidates`, `history`, `history.clear`, `undo`, `caps` |
| `settings-section.tsx` | The Rewind History page (`settings.section` `id: 'rewind'`) and its nav glyph (`settings.section.icon`): workspace header, history list, chain-tail undo, shared config block |
| `settings-card.tsx` | The configuration card on the Plugins page (`plugins.bundle.config`), same form model as the page |
| `hidden.ts` | Pure Chat-snapshot readers and executed-rewind cut derivation; mirrors `ENGINE_COMMAND` |
| `candidates.ts` | Pure candidate listing and `popupSelect` row mapping |
| `pending.ts` | Pure matching of rendered pending-steering bubbles to inbox next-step rows |
| `visibility.ts` | Wraps the registered `chat` view builder and hides the `[target, marker]` span |
| `locales.ts` | Per-language client dictionaries for the eight interface languages |
| `styles.ts` | Injected stylesheet (dsh design tokens, scoped class names) |
| `log.ts` | Namespaced browser logger, gated by the `dsh-rewind.debug` localStorage switch |
| `build-info.ts` | Injected build identity (`__DSH_REWIND_VERSION__`, `__DSH_REWIND_BUILD__`) and the package name |

`scripts/`, eight entry points:

| File | Responsibility |
| --- | --- |
| `build.mjs` | esbuild: `lib/index.js` (host ESM), `lib/client.js` (loader closure), `lib/types/**` |
| `verify-host.mjs` | Boots the built host half on a real cordis context; drives rewind + checkpoint end to end |
| `probe-caps.mjs` | Reports which capabilities an installed DSH line ships (compatibility matrix) |
| `changelog-extract.mjs` | Prints and validates the `CHANGELOG.md` block a release tag owns |
| `session-decode.mjs` | Decodes a concatenated-frame `.jsonl.zstd` session log to plaintext |
| `session-encode.mjs` | Re-encodes a plaintext session log to `.jsonl.zstd` fixtures |
| `update-badge.mjs` | Updates the shields.io tests badge from a vitest JSON report |

`tests/` holds 42 `*.test.ts` suites (planning, snapshot, history, undo, visibility,
client, compatibility, crash safety, integration) plus `helpers.ts`, `scenarios.ts` and
`support/ui-primitives-stub.ts`. `locale/` holds the eight `*.json` language metadata
files; `assets/` holds the icon and the UI screenshots.

## 4. Build and package artifacts

`npm run build` produces the two faces described in
[architecture.md §2](architecture.md). Every `@deepseek-ai/*` import stays external at
build time, so the published tarball carries no harness code. `npm run check` is the
full gate: typecheck (host / client / client-test configs) → build → vitest →
`verify:host` → `npm pack --dry-run`.

## 5. Verification and diagnostics

- `scripts/verify-host.mjs` — end-to-end host verification without a model or UI.
- `scripts/probe-caps.mjs --json` — machine-readable capability report for the
  installed DSH line.
- `tests/compat-*.test.ts` — the compatibility audit (invariants, interop, gaps, tool
  updates); findings are recorded in [compat/audit.md](compat/audit.md).
- `localStorage['dsh-rewind.debug']` — browser diagnostics switch; see
  [compat/diagnostics.md](compat/diagnostics.md).
