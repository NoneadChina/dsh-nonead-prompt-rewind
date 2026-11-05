# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [0.5.3] - 2026-11-05

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 体验优化

- **设置导航里的「回退历史」换上了自己的图标**：一条绕回自身的线 + 左向箭头（「撤销/回退」一笔成形），不再回落到外壳的中性默认字形；它和页面标题里的品牌图标是两件东西，前者说明页面是什么，后者说明插件是谁。

### 其他变更

- **快照自动清理改为默认开启，失活阈值默认 3 天**（原为默认关闭 / 30 天）。超过 3 天没有任何写入的已结束会话，其快照目录会在下一次挂载时被回收；活动会话与对话日志始终不受影响。配置卡片可改回任意天数或关闭，`/snapshot-auto-cleanup off` 同样有效。

### 问题修复

- **回退目标无效时不再吞掉未读插话。** `/rewind @<不存在的序号>`、指向非用户消息、或已被压缩的目标都会被拒绝；此前「丢弃待投递插话」发生在目标校验之前，一次输错的命令会连带丢掉尚未发送的插话。现在只有确认要回退时才丢弃。
- **文件恢复被新版本快照格式拒绝时，历史记录不再标成「完成」。** 对话已回退、文件未动的回退在回退历史里记为「部分完成」，并保留被拒原因，避免看起来两者都回退了。
- **自动清理不再删除仍可恢复的快照目录。** 含未完成（或无法解析）的恢复日志的会话目录现在会被跳过——这类日志是中断回退的恢复凭据，此前整目录回收会把它们一并删掉；由更新版本写入的快照（store 版本更高）同样不再被旧版本清理。
- **撤销只部分成功时不再锁死记录。** 此前即使有文件撤销失败也会写入「已撤销」，导致该条既不能重试也不能回滚；现在只有完全成功才标记，失败时保留可重试状态，并提示原因。
- **恢复写入前复检目标是否变成了符号链接。** 规划阶段已拒绝链接路径，但「规划→写入」之间路径被替换为链接时，写入会穿过链接改到工作区之外；现在每次写入前重新检查并跳过。
- **已跳过（例如父目录被移动）的路径不再让回退历史显示「可撤销」**——这类回退没有产生恢复日志，撤销按钮本不该出现。
- **输入 `/rewind` 时不再可能未经确认就回退最近一条。** 候选列表的可用性此前读本地对话快照、列表本身却来自宿主：快照尚未挂载时命令会落到宿主的无参路径直接执行。现在快照不可用只会放行选择器，不会直接回退。
- **确认框会列出「超过备份上限、无法还原」的文件**，不再显示成「无需还原」。
- **设置页切换会话后，旧的清空/撤销/存档响应不再覆盖新会话的内容**；复制历史失败时也会给出提示，而不是静默。
- **明确了「自动清理」与「显式清空」的边界**：自动清理永远不会删除由更新版本写入的快照；`/snapshot-auto-cleanup run --current --apply` 作为用户的逃生口仍可删除，并在输出里点名被删掉的 store 版本。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported. Internal alpha.

### Improvements

- **The Settings navigation entry for Rewind history carries its own glyph**: a line that loops back on itself under a left arrow — undo in one stroke — instead of the shell's neutral default. It is a different mark from the brand tile in the page heading: one says what the page is, the other says whose plugin it is.

### Chores

- **Snapshot auto-cleanup now defaults to on with a 3-day idle cutoff** (previously off / 30 days). A finished session with no writes for 3 days has its snapshot directory reclaimed on the next mount; the active session and the conversation log are never touched. The configuration card and `/snapshot-auto-cleanup off` still turn it off.

### Bug Fixes

- **A refused rewind target no longer consumes unread steering messages.** `/rewind @<missing seq>`, a target that is not a human user message, or one shadowed by compaction is rejected; the pending-steering drop used to run before that validation, so one mistyped command also discarded messages the user had not sent yet. It now runs only once the rewind is certain to cut the surface.
- **A file restore refused by a newer snapshot format is no longer recorded as a clean success.** A rewind whose conversation moved but whose files were refused now shows "partial" in Rewind history, with the reason kept, instead of looking as if both halves had rolled back.
- **Auto-cleanup no longer reclaims a snapshot directory that still holds a live recovery record.** A session with a non-terminal (or unreadable) restore journal is skipped by the age sweep — that journal is the only way to finish an interrupted rewind — and a store written by a newer build is left alone too.
- **A partially failed undo no longer locks the record.** The entry used to be stamped "restored" even when some files failed, leaving it neither retryable nor rollback-able; only a fully applied undo is stamped now, and a failure keeps the entry retryable with the reason shown.
- **The restore re-checks the target right before writing.** Planning already refuses links, but a path swapped for one between planning and the write would write through it, outside the workspace; each write now re-checks and skips.
- **Paths that were skipped (e.g. a moved parent directory) no longer mark the rewind as undoable** — no restore journal exists for them, so the undo action was guaranteed to fail.
- **A bare `/rewind` can no longer rewind the newest message without confirmation.** The picker's availability read the local chat snapshot while its list comes from the host; with the snapshot not yet mounted, the command fell through to the host's direct path. An unavailable snapshot now only allows the picker to open.
- **The confirmation dialog lists files that exceed the backup cap** instead of claiming there is nothing to restore.
- **A session switch no longer lets a stale clear/undo/archive response overwrite the new session's page**, and a failed "copy as JSON" now reports itself instead of failing silently.
- **The automatic-sweep vs explicit-clear boundary is now spelled out**: the age sweep never removes a snapshot directory written by a newer build; `/snapshot-auto-cleanup run --current --apply` remains the user's escape hatch and names the store version it deleted.

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/v0.5.2...v0.5.3

## [0.5.2] - 2026-11-04

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 兼容性

- **DSH 验证基线前进到 `0.2.2-alpha.3`**（当前内测线）：36 个 `@deepseek-ai/dsh-*` devDependency 全部钉到该版本；声明范围不变，`0.2.2-alpha.2` 与 `0.2.1-0` 线仍准入，缺失能力继续由 `caps` 运行时探测降级。
- 双基线实测：`0.2.2-alpha.3` 与 `0.2.2-alpha.2` 上 `npm run check` 均通过（后者在隔离副本中验证）。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported

### Compatibility

- **The DSH verification baseline moves to `0.2.2-alpha.3`** (the current internal line): all 36 `@deepseek-ai/dsh-*` devDependencies are pinned to it. The declared range is unchanged, so `0.2.2-alpha.2` and the `0.2.1-0` line stay admitted and missing capabilities keep degrading through the runtime `caps` probe.
- Verified on both baselines: `npm run check` passes on `0.2.2-alpha.3` and on `0.2.2-alpha.2` (the latter in an isolated copy).

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/v0.5.1...v0.5.2

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

