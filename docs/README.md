# Documentation

> Project documentation for **dsh-nonead-prompt-rewind** — a DeepSeek Harness plugin
> that rewinds a conversation in place and optionally restores the workspace files
> the same rewind covers.
>
> This directory is the entry point for maintainers and advanced users. The
> user-facing manual is the repository [README](../README.md); the security model
> is [SECURITY.md](../SECURITY.md); collaboration rules are [AGENTS.md](../AGENTS.md).

## Reading paths

| If you want to… | Start here |
| --- | --- |
| Understand what the plugin does and how to install it | [README.md](../README.md) |
| Change the code | [DEVELOPMENT-GUIDE.zh.md](DEVELOPMENT-GUIDE.zh.md) (Chinese) → [architecture.md](architecture.md) |
| Know the on-disk format before touching storage | [format.md](format.md) |
| Find the harness interface behind a call | [harness-reference.md](harness-reference.md) |
| Judge compatibility or explain a known limitation | [compat/audit.md](compat/audit.md), [compat/tracking-boundary.md](compat/tracking-boundary.md) |
| Configure or script snapshot cleanup | [snapshot-auto-cleanup.md](snapshot-auto-cleanup.md) |
| Cut a release | [release/release.md](release/release.md), [release/notes-template.md](release/notes-template.md) |
| Plan the next iteration | [DEVELOPMENT-PLAN.zh.md](DEVELOPMENT-PLAN.zh.md) (Chinese) |

## Map

| Path | What it covers | Audience |
| --- | --- | --- |
| [README.md](README.md) | This index: reading paths, map, conventions | everyone |
| [architecture.md](architecture.md) | Dual-face model, module layering, rewind pipeline, checkpoint pipeline, history/settings data flow, RPC surface, compatibility strategy | maintainers |
| [format.md](format.md) | Durable on-disk formats: snapshot entries, restore journal, history partitions, cleanup state | maintainers |
| [harness-reference.md](harness-reference.md) | DSH subsystems used by the plugin, upstream source references, plugin source layout | maintainers |
| [DEVELOPMENT-GUIDE.zh.md](DEVELOPMENT-GUIDE.zh.md) | Chinese handbook: project shape, mechanisms, build/test/debug, extension points, red lines | maintainers |
| [DEVELOPMENT-PLAN.zh.md](DEVELOPMENT-PLAN.zh.md) | Current baseline and the next-iteration roadmap, each item with acceptance criteria | maintainers |
| [snapshot-auto-cleanup.md](snapshot-auto-cleanup.md) / [.zh.md](snapshot-auto-cleanup.zh.md) | Snapshot auto-cleanup policy, command, state file | users / maintainers |
| [compat/audit.md](compat/audit.md) | Compatibility definition, invariants, open items, coverage gaps | maintainers |
| [compat/tracking-boundary.md](compat/tracking-boundary.md) / [.zh.md](compat/tracking-boundary.zh.md) | Which files a rewind restores and which it cannot | users / maintainers |
| [compat/diagnostics.md](compat/diagnostics.md) / [.zh.md](compat/diagnostics.zh.md) | Browser diagnostics switch, startup identity line, anomaly alerts | users / maintainers |
| [release/release.md](release/release.md) | Release facts, version/tag/dist-tag rules, npm-side setup | maintainers |
| [release/notes-template.md](release/notes-template.md) | CHANGELOG entry format and validation rules | maintainers |
| [DETAIL.md](DETAIL.md) / [DETAIL.zh.md](DETAIL.zh.md) | Plugin-detail prose rendered by the plugins page | packaging |

The plugin-detail pages are prose only; the plugin ships no preview illustration.

## Conventions

- **Language split.** Prose documents are English; `.zh.md` files are their Chinese
  counterparts. The two Chinese handbooks (`DEVELOPMENT-GUIDE.zh.md`,
  `DEVELOPMENT-PLAN.zh.md`) have no English twin by design.
- **One topic, one home.** Compatibility conclusions live in `compat/audit.md` and are
  linked from elsewhere, never restated. The on-disk format lives in `format.md`.
- **Facts have sources.** Version, DSH range, directories, limits, command options and
  error codes are read from `package.json`, `src/`, `tests/` and `CHANGELOG.md`. A doc
  that disagrees with them is a bug.
- **No history in docs.** What changed and when belongs to [CHANGELOG.md](../CHANGELOG.md).
  These documents describe the current state.
- **Relative links only.** Cross-document links are relative so the tree works on
  GitHub, in an npm checkout, and offline.
