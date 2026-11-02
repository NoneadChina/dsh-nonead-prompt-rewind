# Release notes (CHANGELOG) guide

Release notes live in [`CHANGELOG.md`](../../CHANGELOG.md). That file is the single source
of the GitHub Release body: the block for a tag is extracted and used verbatim — never
generated, never retyped. The layout follows [Keep a Changelog](https://keepachangelog.com/):
one block per release, newest first, ISO dates.

> This repository has no `.github/workflows/`, so extraction is a **local manual step**
> (`node scripts/changelog-extract.mjs <tag>`), not something CI currently does.

## Block

```md
## [X.Y.Z] - YYYY-MM-DD

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 新增功能

- 一句说明。（编号写 `#123`；明确贡献者时句末 `@handle`）

### 问题修复

- 一句说明。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported. Internal alpha.

### New Features

- One-sentence statement. (`#123`; `@handle` at the end when the contributor is known)

### Bug Fixes

- One-sentence statement.

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/vPREV...vX.Y.Z
```

The range shown is the one currently in `package.json`; at release time copy the actual
`engines.dsh` value verbatim. The compare URL must end at the tag being released.

## Rules

1. **Chinese first, English second**, separated by `---`; every entry exists in both halves.
2. The compatibility line quotes `engines.dsh` **verbatim, upper bound included**, in both
   halves.
3. Stage word after the range: `内测版`/`Internal alpha.` for `-alpha`, `公测版`/`Public beta.`
   for `-beta`, `候选版`/`Release candidate.` for `-rc`; a stable version omits it.
4. A stable block spanning several intermediates opens with
   `本版汇总了自 \`vPrev\` 以来的主要变更。` / `This release summarizes the main changes since \`vPrev\`.`
5. Only functionality-related net changes: no internal refactors, docs, tests or tooling;
   nothing an unreleased span introduced and then reverted.
6. Categories: `新增功能`/`New Features` (capability), `问题修复`/`Bug Fixes` (user-visible
   defect), `体验优化`/`Improvements` (copy, icon, style, performance), `其他变更`/`Chores`
   (the rest — a DSH line change goes first).
7. Credits at the end of an entry: `(#PR) @handle`; an issue number belongs in the entry's
   text instead, and a change with no pull request carries the handle alone. A handle is
   looked up, never guessed; an unconfirmed identity is written by name.
8. Omit empty sections.
9. `**Full Changelog**` appears **once**, alone on the last line, and ends at this tag.

## Validation (`scripts/changelog-extract.mjs`)

`node scripts/changelog-extract.mjs <tag|version> [--out <file>]` prints the block and
exits non-zero when any rule is broken:

- exactly one heading matches the version — `## [X.Y.Z]` or `## [X.Y.Z] - YYYY-MM-DD`;
  `[Unreleased]` never matches;
- the block has at least one `- ` entry;
- it has exactly one `**Full Changelog**: <url>` line, with the URL alone after the colon;
- that URL matches `/compare/...v<version>` at its end;
- every backticked range on a `>` line equals `package.json`'s `engines.dsh` exactly.

Exit codes: `0` success, `1` validation failure, `2` usage error. A missing or inconsistent
block must be fixed before publishing — it is the release body.

## Lifecycle

- **Develop:** add each user-visible change under `## [Unreleased]`, in both halves.
- **Release (inside the release commit):** rename the block to `## [X.Y.Z] - YYYY-MM-DD`,
  point `vNEXT` at the tag, add the stage word or the summary sentence, and open a fresh
  `## [Unreleased]`.
- **Validate and attach:** run the extractor, then use its output as the GitHub Release body
  (see [`release.md`](release.md)); CHANGELOG entries and `engines.dsh` must agree, because
  the extractor compares them literally.
