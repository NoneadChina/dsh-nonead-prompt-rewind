# Release

> **Current state of this repository:** there is no `.github/workflows/` directory — no CI,
> no automated publish, no Sigstore provenance, no automatic GitHub Release. Every step
> below is run by hand from a local checkout. The Trusted Publisher table is a field
> checklist to fill in *after* a workflow exists; it does not describe an existing setup.

## Facts: read them from the source, not from this page

| Item | Value / where it lives |
| --- | --- |
| Package name | `dsh-nonead-prompt-rewind` |
| Version | currently `0.5.1` in `package.json`; bump it there, never edit this page |
| Repository | `https://github.com/NoneadChina/dsh-nonead-prompt-rewind` |
| License | MIT |
| Node engine | `>=24.9.0` |
| DSH range | `>=0.2.1-0 <0.3.1-0` (`engines.dsh`; the `@deepseek-ai/dsh-*` peers mirror it) |
| DSH dev baseline | `@deepseek-ai/dsh-*` pinned to `0.2.2-alpha.2` |
| Packaged files | `lib/`, `cordis.patch.yml`, `locale/`, `assets/icon.svg`, `SECURITY.md`, a few docs; `CHANGELOG.md` is not shipped |
| Automation | none: the repository contains no workflow files |

## Before any release: `npm run check`

`npm run check` is the release gate and runs, in order: `typecheck` (host + client +
client-test configs), `build` (esbuild → `lib/`), `test` (vitest), `verify:host`
(end-to-end host verification) and `npm pack --dry-run` (tarball layout). A commit that
has not passed it on the release commit is not releasable. `prepack` re-runs the build, so
`npm publish` always ships a complete `lib/`.

## First publish (manual, one-time)

1. Check the name: `npm view dsh-nonead-prompt-rewind version`. A 404 means the name is
   free; a version means this account already owns it.
2. `npm login` and complete the browser flow.
3. `npm run check` — green before anything else.
4. Finalize the `CHANGELOG.md` block for `X.Y.Z` (format: [`notes-template.md`](notes-template.md))
   and validate it: `node scripts/changelog-extract.mjs vX.Y.Z --out release-notes.md`.
   A failure here means the block is wrong; fix it before publishing.
5. `npm publish --access public`. If the CLI asks for `EOTP`, open the printed browser
   link, or retry with `npm publish --access public --otp=<code>`.
6. Tag the release commit: `git tag vX.Y.Z && git push origin main --tags`.
7. Attach the reviewed block as the GitHub Release body:
   `gh release create vX.Y.Z --notes-file release-notes.md --latest`
   (use `--prerelease` for a prerelease).

The first version carries no provenance because it is published from a local path. That is
expected while the repository has no OIDC-capable workflow.

## Version, tag and dist-tag rules

- **One version, one publish.** npm refuses to overwrite a published version; a mistake is
  fixed by bumping the version, never by re-publishing the same one.
- The **dist-tag is derived from the version**, never chosen by hand from the branch: a
  stable version goes to `latest`; a prerelease goes to the dist-tag named by its
  pre-release identifier (`0.6.0-alpha.1` → `alpha`, `0.6.0-rc.1` → `rc`). Pass it
  explicitly (`--tag latest|alpha|rc`), because publishing a prerelease without `--tag`
  would move `latest`.
- The tag is a lightweight **`vX.Y.Z`** on the release commit `chore: release vX.Y.Z`, and
  it must match `package.json` exactly.
- **Tag after a successful publish, never before.** Creating the GitHub Release first tags
  the remote `HEAD` instead of the release commit and breaks the tag/version match.
- Verify afterwards: `npm view dsh-nonead-prompt-rewind dist-tags` and
  `npm view dsh-nonead-prompt-rewind@X.Y.Z version`.

| Release | Source branch | Version bump | dist-tag |
| --- | --- | --- | --- |
| Stable patch on the shipped line | `release/<line>.x` | `npm version patch` | `latest` |
| Prerelease of the next line | `main` | `npm version prerelease --preid=alpha` | `alpha` |
| Stable of the next line | `main` | `npm version <next>` | `latest` |

## CHANGELOG ↔ `engines.dsh` consistency (`changelog-extract`)

`node scripts/changelog-extract.mjs <tag|version> [--out <file>]` reads `CHANGELOG.md` and
`package.json` from the working directory and prints the block a tag owns. It fails closed:

1. exactly one `## [X.Y.Z]` (or `## [X.Y.Z] - YYYY-MM-DD`) block exists for the version;
2. the block contains at least one `- ` entry;
3. it contains exactly one `**Full Changelog**: <url>` line, alone on its line;
4. that URL ends at `vX.Y.Z` — either `/compare/...vX.Y.Z` or, for a first release with no
   predecessor, `/releases/tag/vX.Y.Z`;
5. every backticked range on a `>` line (the "适配 DSH" compatibility line) is **verbatim
   equal to `engines.dsh`**, upper bound included.

Exit codes: `0` success (block on stdout or in `--out`), `1` validation failure, `2` usage
error. Run it before `npm publish`, and use its output as the Release body.

**First-release link form.** A first release has no predecessor, so its block uses the
release-tag URL instead of a compare URL —
`**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/releases/tag/v0.5.1`
for `0.5.1`. The extractor accepts both forms; run it before every publish and use its
output as the Release body.

## Trusted Publisher (not configured yet)

Nothing can be configured until a workflow file exists. Once you add one:

1. Create `.github/workflows/<name>.yml` and commit it.
2. Open `https://www.npmjs.com/package/dsh-nonead-prompt-rewind` → **Settings** →
   **Trusted Publisher** and fill in:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `NoneadChina` |
| Repository | `dsh-nonead-prompt-rewind` |
| Workflow filename | the file you added — there is no workflow in the repository today, so this value cannot be prefilled |
| Environment | empty, unless the workflow declares one |
| Allowed actions | `npm publish` |

The configured workflow must request OIDC (`permissions: id-token: write`) and publish with
`--provenance`; otherwise Trusted Publisher has nothing to bind the publish to.

## What a future workflow must do (checklist — none of it exists today)

- Trigger on a `v*` tag, assert the tag equals `package.json`'s version.
- Run `npm run check` on the tagged commit.
- Run `changelog-extract` **before** the publish and fail on a missing or inconsistent block.
- Publish to the version-derived dist-tag with `--provenance`.
- Be idempotent: skip a version that is already published.
- Create the GitHub Release from the extracted block (`--latest` / `--prerelease`).

## DSH version alignment

`engines.dsh` declares the DSH range the plugin is adapted to and is the sole admission
criterion: when present, DSH reads no other range and admits the plugin only while it
satisfies the runtime under `includePrerelease` (see [compat/audit.md](../compat/audit.md)).
The `@deepseek-ai/dsh-*` peers mirror the same range for hosts that predate `engines.dsh`.
The declaration is not the verification record: the Targeted version in
`docs/compat/audit.md` is, moved each release by pointing the `@deepseek-ai/dsh-*`
devDependencies at the new version and running `npm run check`.

A DSH line break is a MAJOR bump (incompatible with the prior DSH line); within a line,
MINOR/PATCH stay compatible. The plugin's own version never encodes a DSH line. During
`0.x`, MINOR is a feature marker rather than a compatibility promise; `1.0` will be the
first stable line. Branching is trunk-based: `main` is the single integration and release
line, the shipped stable is cut into a short-lived `release/<version>.x` branch for
backports, and fixes go to `main` first, then back to each supported branch.

## Rollback and retraction

- **Notes wrong, version not yet published:** fix the block and re-run `changelog-extract`;
  nothing has left the machine.
- **Wrong dist-tag on a good version:** move it with `npm dist-tag add <pkg>@<good> latest`
  and `npm dist-tag rm <pkg> <bad>`, then fix the publish command.
- **Bad version already public:** prefer `npm deprecate <pkg>@<version> "reason"` and ship a
  patch that supersedes it. `npm unpublish <pkg>@<version>` is only allowed within npm's
  72-hour window and is refused once another package depends on the version; after that,
  contact npm support. Never reuse the version number.
- **Git side:** delete the tag with `git tag -d vX.Y.Z` and
  `git push origin :refs/tags/vX.Y.Z`, and remove the Release with
  `gh release delete vX.Y.Z --yes`.
- **Do not retype or edit a published CHANGELOG block.** The reviewed block is used verbatim;
  corrections go into the next patch's block.
