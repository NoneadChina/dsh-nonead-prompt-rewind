# DSH release matrix

Which DSH core releases this plugin claims, and the evidence behind each claim.

`package.json` declares `engines.dsh` as `>=0.2.1-0 <0.3.1-0`. A range is a
promise, so every installable release inside it must typecheck and pass the
suite. `npm run verify:compat` is the machine that checks the promise: it pins
all `@deepseek-ai/dsh-*` dev dependencies to one release at a time, installs the
tree, runs the three TypeScript configs and vitest, then restores the baseline
`package.json` and install. Nothing about a run is left behind, including after
a failure.

```
npm run verify:compat                  # the declared matrix
npm run verify:compat -- 0.2.2-rc.5    # one release
```

## Claimed releases

| Release | Packages | Result | Notes |
| --- | --- | --- | --- |
| `0.2.1-rc.5` | `@deepseek-ai/dsh-error` absent | pass | Every typecheck config and the full suite pass. The plugin imports none of the absent package, so the release is usable: the install step keeps the baseline version of a package that release never published and reports it as `absent`. |
| `0.2.2-rc.5` | complete | pass | The `latest` and `next` dist-tags, and the version the desktop profile ships. |
| `0.2.3-alpha.2` | complete | pass | Baseline (`devDependencies`); the `alpha` dist-tag. Two things moved: cordis `4.2` replaced the inherited `ctx.root` property with the symbol slot `ctx[Context.root]` (see the shim below), and the release added `dsh-brand`, `dsh-workspace`, `dsh-util-values` and `dsh-system-prompt` as peers of other packages — none is added to `devDependencies`, because nothing on the plugin's load path imports them and the suite resolves without them. |

## The 0.2.0 line: not claimed

`0.2.0-rc.2` typechecks — all three configs pass, which says the API surface the
plugin compiles against exists — but the suite has one recorded difference, and
the release is missing two packages:

| Release | Packages | Typecheck | Suite | Why it is not claimed |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `@deepseek-ai/dsh-error`, `@deepseek-ai/dsh-working-directory` absent | pass | 1 failure (`compat-gaps` G4) | The token-meter projection predates the marker-aware fold (it joined in `0.2.1-alpha.3`, `stateVersion 6`), so `contextBreakdown.messageTokens` follows the cut surface (`12`) instead of the pre-cut log (`48`). That is a host capability the release does not have, not a plugin defect — but a rewind on that line would publish a smaller token figure than the user actually spent, and the plugin cannot fix that from outside. |

`0.2.0-rc.1` is the same line and is not separately claimed. Both 0.2.0
releases also lack `dsh-working-directory`, which `src/index.ts` imports, so a
`0.2.0` host could not resolve the plugin's module graph at all. The typecheck
pass above only proves the typings line up; it is not a claim that the plugin
loads there.

## The 0.3.0 line: nothing to claim

`npm view @deepseek-ai/dsh dist-tags` currently returns
`latest = 0.2.2-rc.5`, `next = 0.2.2-rc.5`, `alpha = 0.2.3-alpha.2`. There is no
`0.3.x` release, so there is nothing to test against; `engines.dsh` stops below
`0.3.1-0` so a future 0.3.0 host refuses the plugin instead of loading it
half-compatible.

When 0.3 lands:

1. `npm run verify:compat -- 0.3.0-rc.1` (or whatever the first tag is). Expect
   typecheck failures first; they name the changed contracts.
2. Fix the plugin against the new line. Shim only where an older claimed line
   still needs the old shape.
3. Add the release to the default matrix in `scripts/verify-compat.mjs` and to
   this table, then widen `engines.dsh` and the `peerDependencies` ranges.

## Compatibility shims

`main` carries two, each only because both sides of it are live in a claimed
release:

- **Attachment read** (`src/client/index.ts`). `0.2.2` takes the complete
  structured reference (`{ attachmentId, mediaType, bytes, width, height, name? }`);
  `0.2.1` takes the bare `AttachmentId`. The plugin's reader calls the
  structured form first and retries with the id when the host returns an error
  or throws, so an image-bearing refill works on both lines.

- **Root context access** (`src/index.ts`, `rootContextOf`). cordis `4.0`
  exposes the application root as the inherited `ctx.root` property; cordis
  `4.2`, shipped with `0.2.3-alpha.2`, replaced it with the symbol slot
  `ctx[Context.root]` (`Symbol.for('cordis.root')`). The reader asks for the
  symbol first and falls back to the property, so the host-RPC re-base — the fix
  for "host RPC unavailable" in Settings → Rewind history — keeps working on
  every claimed line.

Everything else is written against the structural faces the plugin declares for
itself, not against exported types, so a relocated or renamed upstream type does
not break the build.

## Related

- Incompatibility inventory and invariants: [audit.md](audit.md)
- Interfaces the plugin depends on: [../harness-reference.md](../harness-reference.md)
- Release and tag rules: [../release/release.md](../release/release.md)
