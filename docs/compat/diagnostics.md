# Browser diagnostics

[简体中文](diagnostics.zh.md)

Every browser-side diagnostic this plugin emits goes through one small, level-filtered
channel (`src/client/log.ts`), so an anomaly surfaces under a single console filter. The channel
is deliberately narrow: `error` / `warn` record only genuine internal anomalies the plugin
itself detects as off-contract — **not** the normal-path facts the user already sees on screen,
which carry no attribution value. A line always has the form
`[dsh-rewind:<scope>] <message> <data>`; the scope names the subsystem, so a report can be
captured with one Console filter.

## Always-on anomaly alerts

`error` and `warn` print unconditionally — no switch, no configuration — so a fault surfaces
even for a user who never configured anything:

| Level | Meaning | Examples from the source |
| --- | --- | --- |
| `error` | Unexpected, breaking failure | a settings form / card / section failing to register; the Chat visibility install probe failing |
| `warn` | Recoverable anomaly guard | the rewind command, composer refill or image restore throwing; a waited-on rewind outcome never settling; an RPC preview/history/undo call failing or returning an invalid result; a rewind button clicked with no session binding; a pending-steering retract losing its race |

These cases are rare, cheap and off-contract. Normal-path detail — which branch a refill took,
whether a write matched, which rows a rewind cut — is deliberately **not** logged: it restates
what the user already sees and adds nothing to attribution.

## Scopes

| Scope | What an anomaly here means |
| --- | --- |
| `boot` | Startup identity line only (see below); gated by the verbose switch |
| `refill` | The composer refill after a rewind: the command/wait/refill throwing, a rejected or unmatched command, an outcome that never settles within the timeout, an image reference that is incomplete or of an unsupported type, a composer that refuses restored images or throws on the write/focus |
| `preview` | The preview / candidate RPC queries behind the confirmation dialog and the `/rewind` picker: RPC failure, invalid result, timeout, or a throw |
| `history` | The rewind-history and undo endpoints: history read, `history.clear`, `caps`, `undo` failing or returning an invalid result |
| `portals` | Per-message button mount issues: no session binding, the inbox projection subscription failing |
| `retract` | The pending-steering retract path: the remove losing its race (`info`) or throwing (`warn`) |
| `settings` | The configuration card and the Rewind history settings page |
| `visibility` | Installing and maintaining the Chat snapshot visibility wrapper: the install probe failing, the chat-view subscription failing, a chat rebuild failing |

## Startup identity line

`apply` emits exactly one `boot` line per page load:

```text
[dsh-rewind:boot] loaded v<version> (build <hash>)
```

`<version>` is the plugin version injected from `package.json` at build time and `<hash>` is a
short content hash of the client source. Both are replaced by esbuild's `define` block in
`scripts/build.mjs`; when the module is imported outside a build (the test runner), both fall
back to `dev`. This one line answers the cheapest and most common question in a report — *is the
running bundle the fixed one?* — ruling out a stale cache or an un-restarted host. It is `info`,
so it is **off by default**: a normal user's console stays clean.

## Verbose switch

`info` and `debug` are gated by the exclusively-own, per-origin
`localStorage['dsh-rewind.debug']` switch, read on **every call** (never cached) and filtered by
namespace. Flipping it and reloading therefore takes effect on any published build without a
plugin rebuild. Unset / empty means off; a read failure (localStorage unavailable or throwing
during teardown) also means off — logging never breaks the plugin.

```js
// Just the startup identity line.
localStorage['dsh-rewind.debug'] = 'dsh-rewind:boot'

// Several subsystems, comma-separated.
localStorage['dsh-rewind.debug'] = 'dsh-rewind:refill,dsh-rewind:portals'

// Everything (avoids needing an exact scope).
localStorage['dsh-rewind.debug'] = 'dsh-rewind*'
```

Matching follows the usual debug-package convention: comma-separated entries, each an exact
`dsh-rewind:<scope>` or a `*`-suffixed prefix; `*` and `dsh-rewind*` select every namespace.
Reload (`F5`) after setting it; to switch it off, `delete localStorage['dsh-rewind.debug']`.
Gated lines are routed to `console.info`, not `console.debug`: Chrome filters "Verbose" out by
default, so a reporter who turned the switch on would otherwise still see nothing without also
changing the DevTools level filter. The `error` / `warn` alerts are **not** gated — they always
print.

## Capturing a report

1. Reproduce once on the affected page.
2. In DevTools, filter the Console for `dsh-rewind` and copy the output; include the plugin
   version, the DSH/kernel version, and the `boot` line when available.
3. State the surface (a message row, the confirmation dialog, the Settings page) and whether the
   failure was in the conversation half or the file-restore half.

The `error` / `warn` alerts require no setup. Enable the verbose switch only when the `boot`
line, the `visibility` install line, or the `retract` lost-race line is needed.

## Notes

- This diagnostic surface is an aid for maintainers and cooperating reporters, **not** a stable
  public interface; its exact scopes, keys and output may change without notice.
- It is scoped to one browser origin and one browser. Capture where the problem actually occurs;
  another window or a fresh profile has its own storage and its own console.
- Server-side (host) failures are not part of this channel: they surface as the command result
  text and, for the file store, as the localized restore report.
