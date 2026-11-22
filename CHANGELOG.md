# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [Unreleased]

## [0.6.1] - 2026-11-22

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

本版汇总了自 `v0.5.5` 以来的主要变更。

### 新增功能

- **撤销会把回退掉的对话也送回来**：每次回退记录被遮蔽的用户与助手消息，撤销时在日志尾部追加一个**新回合**（`turn/start` … `turn/end`，turn 号取日志的下一个），把这些消息按原顺序重新发布；文件没有改动的纯对话回退同样可撤销，当前回合尚未结束时撤销返回 `rewind/undo-busy`。
- **快照采集默认只收源码与文本**：跳过 `.dsh-tmp`、`.dsh-project-memory` 等宿主簿记目录，构建/渲染目录与浏览器 profile，以及媒体、压缩包、模型、可执行文件等后缀；首见扫描的单文件阈值 1 MiB，工具写入前仍为 8 MiB，可用 `snapshotBinaries` 放开二进制。
- **快照有了字节预算**：每会话 256 MiB、全库 2 GiB，超出后按最旧优先逐出到 80%；仍在保留窗口内的会话与撤销记录不会被逐出。
- **新增回退地平线**：每会话保留最近 7 天或最新 30 组，更早目标只回退对话并在预览里标明文件不可用；有效窗口自动取「地平线天数」与「不活跃时间」的较大值。
- **快照存储升级到 v3**：`objects/<sha256>` 全局对象池让跨会话相同字节共享一份，可压缩文本用 brotli 打包；新增 `/snapshot-auto-cleanup migrate` 与 `gc`（默认预演）。

### 问题修复

- **回退与撤销不再写坏会话日志**：回放的 turn 号此前取「最新日志 turn + 1,000,000」以避开 agent 的内存计数器，但 DSH 的加载校验要求 turn 号从 1 起严格连续、且只在**重新加载**时校验——每次「回退 + 撤销」都会留下下次打开就报 `SessionFormatError: turn/start does not open the expected turn` 的日志。现在写入日志的**下一个** turn 号，并在提交 `turn/start` **之前**校验、推进活动 agent 的回合计数器（`phase.lastTurn`）；agent 未暴露可用计数器时**先失败、不落盘任何回放事件**，由页面提示重载后重试（文件半仍然成功）。
- **回退标记的 `sourceEventSeqs` 一律写扁平数字**：加载校验要求它逐个覆盖被 replace 遮蔽的每一个 surface 节点，旧版把分组（`[start, end]`）原样写进日志，重载时报 `replacement sourceEventSeqs omit a shadowed surface node`；现在写入前展开扁平序列、为空即拒绝。
- **压缩进行中不再写入回放回合**：加载校验禁止 `turn/start`/`turn/end` 跨越未关闭的 `compaction/start`，而运行时 append 不检查这条关系；撤销现在先读日志，压缩未结束就拒绝对话回填（文件半照常恢复），`session/end-seed` 之后视为已放弃的压缩不再阻塞。
- **回放中途失败也会补齐 step/end**：`finally` 在写 `turn/end` 前先关闭仍打开的 step，不再留下「有 turn/end、无 step/end」的日志（加载报 `turn/end does not match the open turn with no open step`）。
- **回退不再动宿主的记忆与工程簿记**：采集与还原排除 `.dsh`、`.dsh-tmp`、`.dsh-project-memory` 等宿主托管目录，回退只处理用户文件，不会因为簿记文件被改写而误报「回退后已改动」。
- **撤销记录不再被后台清理误删**：每个会话保留最新一份已完成回退日志，直到被使用或被新的回退取代；此前下一次写入触发清理后，一秒前的回退就无法撤销。
- **预算逐出不再让撤销误报「回退后已改动」**：撤销按回退前内容的 SHA-256 指纹判定，指纹齐全的回退不再依赖被逐出的旧快照；部分失败的撤销可以直接重试。
- **清空会话后不再把「快照已过期」显示成「无文件」**：删除会话快照时留下墓碑，预览与撤销据此给出明确原因。

### 体验优化

- **「回退历史」页更如实地展示状态**：每行标出「可撤销」或「已被更新的回退取代」，失败提示改为错误样式并带 live region，首屏用骨架占位并补上空态引导。

### 其他变更

- **自动清理不再只跑一次**：由每个挂载只检查一次改为每小时复审，并在超出预算时立即触发；活动会话保护从一个会话扩展到所有在驱动会话。
- **依赖声明补全，版本地板可验证**：`peerDependencies` 补上插件实际 import 的 5 个包（`dsh-agent`、`dsh-api-session-controller`、`dsh-client-ui-conversation`、`dsh-client-ui-input-trigger`、`dsh-client-ui-session`）；新增 `npm run verify:compat`，把依赖分别钉到 `0.2.1-rc.5` 与 `0.2.2-rc.5` 各跑三套类型检查与全量测试（两条线均通过），附件读取对两版签名自适应。`0.2.0` 线缺 `dsh-error` / `dsh-working-directory`，`0.3.x` 尚未发布，两者都不在声明范围内。
- **已损坏的会话可以修回**：`scripts/session-decode.mjs` 解码 → 按出现顺序重排 `turn`/`step` → `scripts/session-encode.mjs` 重新编码，即可让受影响的日志重新满足校验；原文件保持备份。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported. Internal alpha.

This release summarizes the main changes since `v0.5.5`.

### New Features

- **Undo brings the rewound conversation back**: each rewind records the shadowed user and assistant messages, and undo appends a **new turn** (`turn/start` … `turn/end`, numbered with the log's next turn) that republishes them in order; a conversation-only rewind with no file work is undoable as well, and an undo during an open turn returns `rewind/undo-busy`.
- **Capture defaults to source and text**: host bookkeeping directories such as `.dsh-tmp` and `.dsh-project-memory`, build/render directories, browser profiles, and media, archive, model and executable extensions are skipped; the first-seen scan caps a file at 1 MiB while tool writes keep the 8 MiB cap, and `snapshotBinaries` opts back into binary files.
- **Snapshots have byte budgets**: 256 MiB per session and 2 GiB per store, evicting oldest-first down to 80%; sessions still inside the retention window and undo records are never evicted.
- **A retention horizon was added**: each session keeps the last 7 days or the newest 30 anchor groups; older targets rewind the conversation only and the preview marks their files unavailable. The effective window is the larger of the horizon and the inactivity limit.
- **Snapshot storage moved to v3**: a store-wide `objects/<sha256>` pool shares identical bytes across sessions and compressible text is brotli-packed; `/snapshot-auto-cleanup migrate` and `gc` were added (dry-run by default).

### Bug Fixes

- **A rewind or undo no longer writes a log the harness cannot load**: the replay used to number its turn `newest logged turn + 1,000,000` so it could not collide with the agent's in-memory counter, but DSH validation requires turns to run consecutively from 1 and only checks this on **reload** — so every rewind plus undo left a log that failed on the next open with `SessionFormatError: turn/start does not open the expected turn`. The replay now writes the log's **next** turn, validating and advancing the driving agent's turn counter (`phase.lastTurn`) **before** it commits `turn/start`; when the agent exposes no usable counter it **fails first and persists no replay event**, and the page asks for a reload (the file half still succeeds).
- **The cut marker's `sourceEventSeqs` are always flat numbers**: validation requires the list to cover every surface node the replacement shadowed; the previous version wrote groups (`[start, end]`) verbatim and a reload failed with `replacement sourceEventSeqs omit a shadowed surface node`. The list is now flattened before writing, and an empty one is refused.
- **No replay turn is written while a compaction is open**: validation forbids `turn/start`/`turn/end` crossing an unclosed `compaction/start`, while runtime `append` does not check it. Undo now reads the log first and refuses the dialogue half while a compaction is open (the file half still restores); a compaction abandoned by `session/end-seed` no longer blocks.
- **A replay that fails midway still closes its step**: `finally` closes any open step before writing `turn/end`, so a log never ends with `turn/end` and no `step/end` (which loads as `turn/end does not match the open turn with no open step`).
- **A rewind no longer touches the harness's own bookkeeping**: capture and restore skip host-managed directories (`.dsh`, `.dsh-tmp`, `.dsh-project-memory`), so a rewind only handles user files and no longer reports "changed after the rewind" because a bookkeeping file was rewritten.
- **The undo record is no longer reclaimed by background pruning**: each session keeps its newest completed restore journal until it is used or superseded; previously the next write's cleanup made a rewind that was seconds old impossible to undo.
- **Budget eviction no longer makes undo report "changed after the rewind"**: undo compares a SHA-256 fingerprint of the restored bytes, so fingerprinted rewinds no longer depend on evicted snapshots, and a partially applied undo can be retried directly.
- **Clearing a session no longer shows "expired snapshots" as "no files"**: deleting a session's snapshots leaves a tombstone, which the preview and undo report as an explicit reason.

### Improvements

- **The rewind history page now shows status honestly**: each row is marked undoable or superseded by a newer rewind, failures use the error style with a live region, and the first paint uses skeletons with empty-state guidance.

### Chores

- **Automatic cleanup no longer runs once per mount**: it re-checks hourly and fires immediately when a budget is exceeded, and active-session protection covers every driving session instead of one.
- **Package declarations are complete and the version floor is verifiable**: `peerDependencies` now names the five DSH packages the plugin actually imports (`dsh-agent`, `dsh-api-session-controller`, `dsh-client-ui-conversation`, `dsh-client-ui-input-trigger`, `dsh-client-ui-session`), and `npm run verify:compat` pins the tree to `0.2.1-rc.5` and `0.2.2-rc.5` in turn, rerunning every typecheck config and the whole suite (both lines pass). The attachment read adapts to both signatures. The `0.2.0` line is not claimed — it lacks `dsh-error` / `dsh-working-directory` — and no `0.3.x` release exists yet.
- **A corrupted session can be repaired**: decode with `scripts/session-decode.mjs`, reorder `turn`/`step` in occurrence order, then re-encode with `scripts/session-encode.mjs` to make an affected log pass validation again; the original file stays backed up.

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/v0.5.5...v0.6.1

## [0.5.5] - 2026-11-19

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 其他变更

- **DSH 验证基线前进到 `0.2.2-rc.5`**（当前内测线）：36 个 `@deepseek-ai/dsh-*` devDependency 全部钉到该版本；声明范围不变，`0.2.2` 线此前各版本与 `0.2.1-0` 线仍准入，缺失能力继续由 `caps` 运行时探测降级。
- **devDependencies 补齐 `@deepseek-ai/dsh-error`**：rc 线的 `dsh-llm` 在模块加载时直接 import 该包，并把它声明为自身的 peer；本仓库以 `legacy-peer-deps` 安装、不会自动拉取 peer，缺包时测试会在加载 `dsh-llm` 处报 `Cannot find package` 失败。该包只被本仓库的测试与构建使用，插件本身从不 import 它。
- 双基线实测：`0.2.2-rc.5` 与 `0.2.2-rc.4` 上 `npm run check` 均通过（后者在隔离副本中验证）；两版本之间 239 个运行时代码文件与 638 个类型声明文件逐字节相同，差异只在 46 个包清单的版本号字段。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported. Internal alpha.

### Chores

- **The DSH verification baseline moves to `0.2.2-rc.5`** (the current internal line): all 36 `@deepseek-ai/dsh-*` devDependencies are pinned to it. The declared range is unchanged, so every earlier `0.2.2` build and the `0.2.1-0` line stay admitted and missing capabilities keep degrading through the runtime `caps` probe.
- **`@deepseek-ai/dsh-error` added to devDependencies**: the rc line's `dsh-llm` imports that package at module load and declares it as one of its own peers, and this repository installs with `legacy-peer-deps`, which does not pull peers automatically — without it the test run fails while loading `dsh-llm` with `Cannot find package`. The package is used only by this repository's tests and build; the plugin itself never imports it.
- Verified on both baselines: `npm run check` passes on `0.2.2-rc.5` and on `0.2.2-rc.4` (the latter in an isolated copy); across the two versions all 239 runtime JS files and 638 declaration files are byte-identical, differing only in the version fields of 46 package manifests.

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/v0.5.4...v0.5.5

## [0.5.4] - 2026-11-06

> 适配 DSH `>=0.2.1-0 <0.3.1-0`（内测版）

### 问题修复

- **撤销回退之后，文件不再脱离追踪。** 设置页「恢复到回退之前」和 `/rewind` 一样直接改写工作区，但没有把改写后的状态同步给宿主的文件观察缓存：撤销之后对该文件的下一次写入会被判定为「版本已过期」而失败，而失败的那次写入会丢弃回退前的备份，于是这个文件从此不再产生检查点。现在撤销与回退共用同一套收尾——同步文件观察、失效该会话的轮次锚点缓存、把被恢复的路径重新纳入追踪，撤销后继续编辑的文件会照常进入回退链。

---

> DSH `>=0.2.1-0 <0.3.1-0` supported. Internal alpha.

### Bug Fixes

- **A file no longer drops out of checkpointing after an undone rewind.** The history page's "restore to before this rewind" writes the worktree directly, exactly like `/rewind`, but it never re-synced the host's file-observation cache: the session's next write of that file was judged stale and failed, and that failed call discards its before-capture — so the file stopped producing checkpoints. Undo and rewind now share one settle step (re-emit the observations, drop the session's turn-anchor cache, re-track the restored paths), so editing a file after an undo keeps it in the rewind chain.

**Full Changelog**: https://github.com/NoneadChina/dsh-nonead-prompt-rewind/compare/v0.5.3...v0.5.4

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

