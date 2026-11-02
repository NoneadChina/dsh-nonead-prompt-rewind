# AGENTS.md

> dsh-nonead-prompt-rewind — a DeepSeek Harness (DSH) plugin that rewinds a conversation in place
> to any earlier user message, optionally restoring workspace files along with it.
> This is the shared spec for every developer and agent working on this repo.

## Positioning & principles
- **Focused on purpose**: it does exactly one thing — rewind to any earlier user
  message in the same window, never forking a session or switching windows.
- **Security first**: session logs are append-only and conversations are never
  deleted; file restores draw only from the plugin's own backup directory.
- **Minimal**: avoid over-abstraction; keep the plugin light and maintainable.

## Common commands
| Command | Purpose |
| --- | --- |
| `npm run check` | one-shot full gate: typecheck + test + build + verify:host + `npm pack --dry-run` |
| `npm run build` | esbuild → `lib/` (`index.js` host ESM, `client.js` client closure, `types/` declarations) |
| `npm run typecheck` | tsc --noEmit (host / client / client-test configs) |
| `npm test` | vitest |
| `npm run verify:host` | end-to-end host verification (full check suite) |

`@deepseek-ai/*` dependencies stay external at build time — the DSH host resolves
them at runtime, so the published tarball does not carry them.

## Layout at a glance
- `src/index.ts` — host plugin: `/rewind`, `/undo`, `/snapshot-auto-cleanup`
  commands + checkpoint pipeline (`tools/execute` | `post-execute`) + the
  `/dsh-rewind` RPC channel (`preview`, `candidates`, `history`,
  `history.clear`, `undo`, `caps`)
- `src/rewind.ts` — pure planning: target resolution, surface range, candidate listing
- `src/snapshot.ts` — checkpoint store (on-disk before-backups, restore/preview,
  bounded prune, journaled restore + `rollbackRestore` / `undoRestore`)
- `src/history.ts` — rewind audit trail: per-workspace partitions (10 entries each),
  atomic writes, corrupt-file recovery, chain helpers for the one-shot undo
- `src/snapshot-cleanup.ts` — cleanup policy + plugin-entry config persistence + auto-sweep throttle
- `src/locales.ts` — host i18n (`t()` renderer, `HostKey`)
- `src/client/` — client plugin: per-message ↶ button, single-stage confirmation
  dialog (`confirm.ts`), the Settings page (`settings-section.tsx`), RPC client
  (`host-rpc.ts`), hidden-span computation
- `scripts/` — `build.mjs` (artifacts), `update-badge.mjs` (badge), `verify-host.mjs` (host verification),
  `changelog-extract.mjs` (release-note extraction),
  `probe-caps.mjs` (static capability probe), `session-decode.mjs` / `session-encode.mjs` (log codec)
- `docs/` — maintainer documentation, indexed by `docs/README.md`: `compat/` (compatibility audit,
  file-rewind boundary, browser diagnostics), `release/` (release workflow, notes template), plus
  `architecture.md`, `format.md`, `harness-reference.md`, the Chinese `DEVELOPMENT-GUIDE.zh.md`
  (handbook) and `DEVELOPMENT-PLAN.zh.md` (roadmap); repo root holds `SECURITY.md` and this file
- `tests/` — vitest suites (rewind / snapshot / history / undo / hidden / client / integration)

## Conventions
- Code comments are written in English; git history uses conventional commits with
  English subjects (`feat`/`fix`/`docs`/`test`/`chore`/...).
- Commit **one logical change per commit**: finish one feature/fix, run `npm run
  check`, then commit and push before starting the next change.
- Every change must pass `npm run check` before it is committed.
- DSH compatibility is iteration-driven: `main` always adapts to the **latest**
  DSH line — cross-version compatibility is not kept, and a shipped DSH line is
  preserved only on its release branch (see `docs/release/release.md`).

## Further reading
- Interfaces / compatibility: `docs/harness-reference.md`, `docs/compat/audit.md`
- Release & DSH version alignment: `docs/release/release.md`
