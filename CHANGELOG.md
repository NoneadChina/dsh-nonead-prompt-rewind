# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [0.5.1] - 2026-11-02

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 版本线重设

- **版本号初始化为 `0.5.1`**（原为 `0.21.0-alpha.1`）。本仓库已从上游 `dsh-rewind` 派生为 `dsh-nonead-prompt-rewind`，版本线在这里重新开始：`0.5.x` 是本项目自己的版本，**不是**上游 `0.20.x` 的续号。下方 `0.20.x` 及更早条目是上游历史，仅作留存。

### 破坏性变更

- **包名改为 `dsh-nonead-prompt-rewind`**（原 `dsh-rewind-plugin`）。安装名与插件页的条目 id 随之变化：已安装旧版的配置与备份目录**不会自动迁移**，需要重新安装并重新设置。命令 `/rewind`、`/undo`、撤销与历史的 RPC 通道、备份目录名、日志前缀与样式前缀均保持不变，已有快照数据无需移动。

### 新功能

- **回退只需要一次确认。** 去掉「仅回退对话 / 回退对话和文件」的模式选择：点 `↶` 后弹出确认框，列出将被还原或删除的文件；确认一次，对话与文件同时回退。
- **设置面板新增「回退」页**（设置 → 回退）：按工作区列出最近 10 次回退，含时间、目标消息与文件数。选中链尾的一条可**恢复到回退之前**——只还原文件，每条仅一次；若回退之后又有文件被改动，撤销会被拒绝而不是覆盖你的修改。
- **回退历史按工作区分区**，互不可见，各自保留最新 10 条。
- 同一页提供备份开关与自动清理配置（与插件页卡片共用同一份暂存改动）。

### 兼容性

- 适配 DSH `>=0.2.1-0 <0.3.1-0`；宿主缺失的能力按运行时探测降级，设置页会写明缺什么，而不是静默失效。

### 问题修复

- **Windows 上回退的备份日志从未写入。** 日志里的相对路径带反斜杠，被安全校验拒绝，而写入失败又被静默吞掉——结果崩溃恢复与「撤销回退」在 Windows 上完全不可用。引用统一为 POSIX 形式后恢复正常。
- 回退刚完成、立刻打开设置页时可能读不到这条记录；历史写入改为在命令返回前完成。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported

### Breaking

- **Version line reset to `0.5.1`** (was `0.21.0-alpha.1`): this repository descends from upstream `dsh-rewind` but is its own product now, so the `0.5.x` line starts here — it does **not** continue upstream's `0.20.x`. The upstream entries below are kept for history only.
- **Renamed to `dsh-nonead-prompt-rewind`** (was `dsh-rewind-plugin`). The install name and the plugin-entry id changed; an existing install's settings and backup directory are **not** migrated automatically. The `/rewind` and `/undo` commands, the rewind RPC channel, the snapshot directory names, the log prefix and the style prefix are unchanged, so existing snapshots keep working.

### Added

- **One confirmation, no mode choice.** The `↶` button opens a single dialog listing the files to restore or delete; confirming rewinds the conversation and the files together.
- **A Rewind page in Settings** listing the last 10 rewinds per workspace, with an one-shot "restore to before this rewind" on the newest entry (files only; refused when a file changed afterwards).
- Rewind history is partitioned per workspace and capped at 10 entries each.

### Fixed

- **The restore journal was never written on Windows** — a backslash in the stored relative path was rejected by the safety check and the failure was swallowed, so crash recovery and undo did not work there. Refs are now POSIX.
- A history read right after a rewind could miss the entry it had just created.

首个自有版本。上游 `0.20.x` 及更早的历史见下方条目。

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/releases/tag/v0.5.1

## [0.20.0-alpha.2] - 2026-11-02

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **撤回未读插话时，插话自己的图片也会回到输入框。** 此前只回填文字，重发会丢掉图片；沿用已读消息的图片回填通道。 (#68) @slev-agent @SiriLee

---

> DSH `>=0.2.2-alpha.2 <0.3.0-0` supported. Internal alpha.

### Bug Fixes

- **Withdrawing an unread steering message now restores its own images to the composer.** Only the text came back before, so re-sending silently dropped the pictures; the existing image-restore path is reused. (#68) @slev-agent @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.20.0-alpha.1...v0.20.0-alpha.2

## [0.20.0-alpha.1] - 2026-10-28

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **图片回填适配 DSH 0.2.2。** 撤回带图消息时按宿主校验的完整图片引用读取，图片在进入输入框时上传，不再因引用校验而丢失。 @SiriLee

### 体验优化

- **插件页新增功能配图。** 详情区用中英各一张 SVG 配图展示核心操作，配置卡紧随其后。 @SiriLee
- **新增西班牙语、法语、德语、俄语、巴西葡萄牙语界面。** 跟随 DSH 上游支持的语言；原有的日语译文自然生效，无需额外安装语言包。宿主命令文案、客户端弹层与设置卡、插件卡片元数据都跟随宿主语言；详情配图仍为中英双语，其他语言回退英文图。译文由 AI 生成，欢迎母语者更正。 (#63) @SiriLee

### 其他变更

- **适配 DSH `0.2.2-alpha.2`。** 最低 Node.js 提升到 24.9；0.19.1 继续支持 0.2.1 线。 @SiriLee

---

