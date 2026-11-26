# DSH release matrix

Which DSH core releases this plugin claims, and the evidence behind each claim.

`package.json` declares `engines.dsh` as `>=0.2.1-alpha.3 <0.3.1-0`. A range is a
promise, so every installable release inside it must typecheck and pass the
suite — the default matrix is **every** installable release in the range, not a
sample. `npm run verify:compat` is the machine that checks the promise: it pins
all `@deepseek-ai/dsh-*` dev dependencies to one release at a time, installs the
tree, runs the three TypeScript configs and vitest, then restores the baseline
`package.json` and install. Nothing about a run is left behind, including after
a failure.

```
npm run verify:compat                  # every claimed release (17)
npm run verify:compat -- 0.2.2-rc.5    # one release
npm run verify:compat -- --unclaimed   # only the recorded-out builds
npm run verify:compat -- --all         # claimed + recorded-out builds
```

## Why the floor is `0.2.1-alpha.3`

`0.2.1-alpha.1` and `0.2.1-alpha.2` install, typecheck and run, but they predate
the marker-aware token fold (`stateVersion 6`, which joined in
`0.2.1-alpha.3`). A rewind there publishes the cut surface's smaller token
figure — `12` where the pre-cut log says `48` in the `compat-gaps` G4 probe — so
a user would read spend they never saved. That is a host capability the plugin
cannot supply from outside. Rather than declare a range it cannot honour, those
two builds are **recorded unclaimed**: `npm run verify:compat -- --unclaimed`
re-measures them, their failure does not turn the run red, and the script says
so if they ever start passing.

`0.2.1-alpha.1` is additionally the only build in the line that never published
`@deepseek-ai/dsh-working-directory`, which `src/index.ts` imports as a type.

## Claimed releases — all 17 verified

| Release | Packages | Result | Notes |
| --- | --- | --- | --- |
| `0.2.1-alpha.3` | `dsh-error` absent | pass | Floor. The marker-aware token fold (`stateVersion 6`) is present from here. |
| `0.2.1-alpha.4` | `dsh-error` absent | pass | |
| `0.2.1-alpha.5` | `dsh-error` absent | pass | |
| `0.2.1-rc.1` | `dsh-error` absent | pass | |
| `0.2.1-rc.2` | `dsh-error` absent | pass | |
| `0.2.1-rc.3` | `dsh-error` absent | pass | |
| `0.2.1-rc.4` | `dsh-error` absent | pass | |
| `0.2.1-rc.5` | `dsh-error` absent | pass | First claimed release this plugin shipped against. |
| `0.2.2-alpha.2` | `dsh-error` absent | pass | |
| `0.2.2-alpha.3` | `dsh-error` absent | pass | |
| `0.2.2-rc.1` | `dsh-error` absent | pass | |
| `0.2.2-rc.2` | complete | pass | First build that ships every package the plugin's dev tree names. |
| `0.2.2-rc.3` | complete | pass | |
| `0.2.2-rc.4` | complete | pass | |
| `0.2.2-rc.5` | complete | pass | The `latest` and `next` dist-tags, and the version the desktop profile ships. |
| `0.2.3-alpha.1` | complete | pass | |
| `0.2.3-alpha.2` | complete | pass | Baseline (`devDependencies`); the `alpha` dist-tag. Two things moved: cordis `4.2` replaced the inherited `ctx.root` property with the symbol slot `ctx[Context.root]` (see the shim below), and the release added `dsh-brand`, `dsh-workspace`, `dsh-util-values` and `dsh-system-prompt` as peers of other packages — none is added to `devDependencies`, because nothing on the plugin's load path imports them and the suite resolves without them. |

A missing package is a fact about that release, not about the plugin's runtime
contract: those packages are dev-only here (the plugin imports none of them at
runtime), so the install step keeps the baseline version of a package the
release never published and reports it as `absent` next to the row.

## Recorded unclaimed: `0.2.1-alpha.1`, `0.2.1-alpha.2`

| Release | Packages | Typecheck | Suite | Why it is not claimed |
| --- | --- | --- | --- | --- |
| `0.2.1-alpha.1` | `dsh-error`, `dsh-working-directory` absent | pass | 1 failure (`compat-gaps` G4) | Pre-`stateVersion 6`: the token breakdown follows the cut surface (`12`) instead of the pre-cut log (`48`). |
| `0.2.1-alpha.2` | `dsh-error` absent | pass | 1 failure (`compat-gaps` G4) | Same gap; `dsh-working-directory` returns, the token fold does not. |

Both are installable and load, which is why they are recorded rather than
deleted from the script: the difference is a measured fact, and
`npm run verify:compat -- --unclaimed` re-measures it.

## The 0.2.0 line: not claimed

`0.2.0-rc.2` typechecks — all three configs pass, which says the API surface the
plugin compiles against exists — but the suite has one recorded difference, and
the release is missing two packages:

| Release | Packages | Typecheck | Suite | Why it is not claimed |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `@deepseek-ai/dsh-error`, `@deepseek-ai/dsh-working-directory` absent | pass | 1 failure (`compat-gaps` G4) | Same token-fold gap as the two `0.2.1` alphas above: the figure follows the cut surface, not the log. |

`0.2.0-rc.1` is the same line and is not separately claimed. Both 0.2.0
releases also predate `dsh-working-directory`, so the typecheck above only
proves the typings line up against the substituted baseline — it is not a claim
that the plugin loads there.

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
3. Add the release to `CLAIMED_MATRIX` in `scripts/verify-compat.mjs` and to this
   table, then widen `engines.dsh` and the `peerDependencies` ranges.

## Compatibility shims

`main` carries one, and only because both sides of it are live in a claimed
release:

- **Attachment read** (`src/client/index.ts`). `0.2.2` takes the complete
  structured reference (`{ attachmentId, mediaType, bytes, width, height, name? }`);
  `0.2.1` takes the bare `AttachmentId`. The plugin's reader calls the
  structured form first and retries with the id when the host returns an error
  or throws, so an image-bearing refill works on both lines.

There is deliberately **no** root-context shim any more. 0.6.5 read
`ctx[Context.root]` and fell back to the inherited `ctx.root` so that the
host-RPC channel could re-base its service onto the application root; on
`0.2.3-alpha.2` that compiles but still does not mount the channel, because
`connection.rpc.handle` resolves `webServer` from the context the Connection
service is *read from*, and the root resolves no WebServer either. See
[U10 in audit.md](audit.md#u10--generic-rpc-route-registration-fails-from-a-plugin-scope)
for the invariant and the working registration.

Everything else is written against the structural faces the plugin declares for
itself, not against exported types, so a relocated or renamed upstream type does
not break the build.

## Related

- Incompatibility inventory and invariants: [audit.md](audit.md)
- Interfaces the plugin depends on: [../harness-reference.md](../harness-reference.md)
- Release and tag rules: [../release/release.md](../release/release.md)
