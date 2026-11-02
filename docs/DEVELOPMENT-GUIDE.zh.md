# dsh-nonead-prompt-rewind 开发指南

> 面向接手开发者的当前状态手册，描述版本 **0.5.1** 的仓库实况。
> 用户视角的行为说明在 [README](../README.md)；模块分层与流水线见 [architecture](architecture.md)；
> 磁盘格式见 [format](format.md)；DSH 接口见 [harness-reference](harness-reference.md)；
> 兼容性结论见 [compat/audit](compat/audit.md)。**变更历史只属于 [CHANGELOG](../CHANGELOG.md)**，
> 本文不记录"以前是什么、后来改成什么"。

## 阅读路径

| 你想做什么 | 从这里开始 |
| --- | --- |
| 先跑起来、跑一遍全检 | 本文 §7、[README · 开发](../README.md) |
| 改动回退或快照逻辑前的准备 | 本文 §4、§5，[architecture](architecture.md) |
| 改磁盘格式 | [format](format.md)、[SECURITY](../SECURITY.md) |
| 查某个 DSH 接口来自哪个包 | [harness-reference](harness-reference.md) |
| 判断某项能力缺失是 bug 还是宿主缺能力 | [compat/audit](compat/audit.md)、[compat/diagnostics.zh](compat/diagnostics.zh.md) |
| 发版 | [release/release](release/release.md)、[release/notes-template](release/notes-template.md) |
| 规划下一步 | [DEVELOPMENT-PLAN.zh](DEVELOPMENT-PLAN.zh.md) |

---

## 1. 项目定位

### 1.1 一句话

在同一窗口内**就地**把对话回退到任意更早的用户消息：目标消息及其之后的内容从模型上下文与渲染对话中一起撤回，目标文本回填输入框；写前快照可把该区间覆盖的工作区文件一并还原。

不新建会话、不新建分支、不切换窗口，也不产生会话副本。

### 1.2 能力清单

| 能力 | 实现位置 | 用户可见形式 |
| --- | --- | --- |
| 就地回退对话 | `src/rewind.ts` + `src/index.ts` 的 `executeRewind` | 每条用户消息旁的 ↶ 按钮 |
| 追加式回退标记 | `src/marker.ts` + `session.append` | 对话只遮蔽、日志不删 |
| 文件写前备份与还原 | `src/snapshot.ts` | 确认框中的文件清单；回退时一并生效 |
| 候选选择 | `src/client/candidates.ts`、`src/client/index.ts` 的命令装饰 | 裸 `/rewind` 打开候选面板 |
| 目标文本/图片回填 | `src/client/portals.tsx`、`src/client/index.ts` | 回退后输入框自动带回原文 |
| 回退历史与撤销 | `src/history.ts`、`src/index.ts` 的 RPC | 设置 →「回退历史」 |
| 快照自动清理 | `src/snapshot-cleanup.ts` | `/snapshot-auto-cleanup` + 配置卡 |
| 8 种界面语言 | `src/locales.ts`、`src/client/locales.ts` | 跟随 DSH 界面语言 |

### 1.3 明确不做的事

这些不是"暂未实现"，而是设计边界；改动前先确认需求是否越过边界：

| 不做 | 原因 |
| --- | --- |
| 整树 / Git 级快照 | 只追踪写类工具碰过的文件 + 已追踪文件的外部变更；不依赖 git，也不备份整个工作区 |
| 子代理会话的追踪与回退 | 子代理运行在自己的会话里，其备份无法由父会话回退消费；宿主也拒绝子代理身份的通用 Session RPC |
| fork / 分支回退 | DSH 已内置「在新对话中分支」，不重复造轮子 |
| 浏览器端自建菜单/浮层框架 | 候选使用宿主 `popupSelect`；确认框是极小的纯 DOM 实现 |
| 网络请求、凭据访问、git 操作 | 安全模型见 [SECURITY](../SECURITY.md) |
| 改写或删除会话历史 | 会话日志 append-only；`/export` 仍能看到被撤回的内容（已文档化的行为） |

### 1.4 版本与支持范围

| 项 | 当前值 | 事实来源 |
| --- | --- | --- |
| 包名 / 版本 | `dsh-nonead-prompt-rewind` `0.5.1` | [package.json](../package.json) |
| 许可 | MIT | [LICENSE](../LICENSE) |
| Node | `>=24.9.0` | `engines.node` |
| DSH | `>=0.2.1-0 <0.3.1-0` | `engines.dsh`（自 DSH 0.2.1-alpha.4 起是唯一准入判据） |
| 验证基线 | devDependencies 全部钉 `0.2.2-alpha.2` | [package.json](../package.json)；记录在 [compat/audit](compat/audit.md) 的 Targeted version |
| 仓库自动化 | **没有** `.github/workflows/` | 仓库根目录实况；见 PLAN 待办 |
| 界面语言 | 8：`en` `zh` `ja` `es` `fr` `de` `ru` `pt` | `HOST_DICTS` / `CLIENT_DICTS` |
| 测试规模 | `tests/` 下 42 个 `*.test.ts` | 目录实况 |

### 1.5 规模（当前 HEAD）

| 项 | 数值 |
| --- | --- |
| `src/` | 21 个 TypeScript/TSX 文件，约 1.1 万行 |
| host 半 | 7 个文件，其中 `src/index.ts` 1823 行、`src/snapshot.ts` 3018 行 |
| client 半 | 14 个文件，其中 `src/client/portals.tsx` 954 行、`src/client/index.ts` 548 行 |
| `tests/` | 42 个 `*.test.ts` + `support/`、`helpers.ts`、`scenarios.ts` |
| `scripts/` | 8 个 `.mjs` |
| `docs/` | 17 个 Markdown + 预览图 |

---

## 2. 目录与模块职责

### 2.1 顶层

```
package.json          # 双面包声明：main / exports / dsh.bundle / dsh.client / engines / files
cordis.patch.yml      # bundle patch：一行，把本包装进 profile
tsconfig.base.json    # 公共编译选项（ES2024、strict、Bundler、allowImportingTsExtensions）
tsconfig.json         # host + 大多数 tests 的类型检查
tsconfig.client.json  # client 半：只产 .d.ts
tsconfig.client-test.json # client 测试的类型检查（jsx、node 类型）
tsconfig.build.json   # host 半：产 lib/types/*.d.ts
vitest.config.ts      # environment node + primitives 桩的 alias
src/                  # 源码（host + client）
tests/                # vitest 套件与测试脚手架
scripts/              # 构建、验证、诊断脚本
docs/                 # 文档、格式规范、兼容性记录、发布说明
locale/               # 插件详情页元数据（8 个 json）
assets/               # icon.svg 与 screenshots/
```

### 2.2 host 半（`src/`）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `src/index.ts` | 插件入口：命令注册、工具流水线钩子、RPC 通道、配置 schema、会话事件、清理接线 | `name`、`inject`、`apply`、`Config`、`ENGINE_COMMAND`、`SnapshotStore` 再导出 |
| `src/rewind.ts` | 纯规划：目标解析、候选列表、surface 区间、错误码 | `parseRewindTarget`、`planRewind`、`listRewindCandidates`、`RewindError`、`DEFAULT_CANDIDATE_LIMIT` |
| `src/marker.ts` | 标记的消息源身份（`dsh-rewind`），无 cordis/node 依赖的叶子模块 | `REWIND_MARKER_SOURCE` |
| `src/snapshot.ts` | 检查点存储：捕获提交、还原计划、journal、崩溃恢复、prune、版本守卫 | `SnapshotStore`、`reconcileTracked`、`DEFAULT_MAX_FILE_BYTES`、`MAX_ANCHOR_GROUPS`、`CURRENT_STORE_VERSION` |
| `src/history.ts` | 回退历史：按工作区分区、原子写、损坏文件移开、链尾工具 | `HistoryStore`、`workspaceKeyFromRegistry`、`cwdKey`、`errorText`、`previewText` |
| `src/snapshot-cleanup.ts` | 清理策略：校验、持久化适配、命令语法、24h 节流 | `parseCleanupCommand`、`runAutoCleanupCheck`、`volatileCleanupStore`、`DEFAULT_CLEANUP_CONFIG` |
| `src/locales.ts` | host 侧文案（命令输出、错误、结果） | `HOST_DICTS`、`translate`、`preferredLocale`、`HostKey` |

依赖方向（改动时守住）：

```
index.ts → rewind.ts / marker.ts / snapshot.ts / history.ts / snapshot-cleanup.ts / locales.ts
snapshot.ts → node:fs + 注入 seam（DiskProbe / DeleteFile / crash hook）
rewind.ts   → 只读 SessionEvent / surface，无 I/O、无 Session 实例
```

`rewind.ts` 必须是纯的、`snapshot.ts` 必须与宿主无关——这两条是"能脱离 DSH 单测"的前提。

### 2.3 client 半（`src/client/`）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 客户端入口：注册 locale、注入样式、安装可见性补丁、注册三个槽位、命令装饰 |
| `portals.tsx` | React portal 桥：每消息 ↶ 按钮、pending 撤回按钮、`runRewindAndFill`、输入框写入 |
| `confirm.ts` | 单阶段确认框（纯 DOM）：影响清单、焦点、键盘、定位、关闭 |
| `candidates.ts` | 纯函数候选计算（chat 快照 → popupSelect 行） |
| `hidden.ts` | chat 快照读取、回退 cut 推导、目标文本/图片引用提取、引擎命令判定 |
| `visibility.ts` | 包装 chat 视图 builder，把 `[target, marker]` 区间标记 `visibility: 'hidden'` |
| `pending.ts` | 纯函数：DOM 中的 pending 气泡与 inbox `next-step` 行配对、撤回区间 |
| `host-rpc.ts` | `/dsh-rewind` 的浏览器客户端：preview / candidates / history / history.clear / undo / caps |
| `settings-section.tsx` | 设置页「回退历史」：列表、导出、清空、链尾撤销、能力降级提示 |
| `settings-card.tsx` | 插件配置卡：备份开关、自动清理开关与失活天数；与设置页共用同一表单模型 |
| `locales.ts` | client 文案（按钮、确认框、设置页、配置卡、错误码映射） |
| `styles.ts` | 全部 CSS 与 class 名常量（`dsh-rewind-*`、`CLASS.*`） |
| `log.ts` | 浏览器日志通道与 `dsh-rewind.debug` 开关 |
| `build-info.ts` | 构建期注入的 `PLUGIN_VERSION` / `BUILD_HASH` / `PLUGIN_PACKAGE` |

### 2.4 scripts/

| 脚本 | 用途 |
| --- | --- |
| `build.mjs` | 清理 `lib/`、产 `.d.ts`、esbuild 打包 host/client、包装 loader 闭包、冒烟检查 |
| `verify-host.mjs` | 真 cordis `Context` + 真 `Session` + 临时目录的端到端验证（含 `/compact` 链） |
| `probe-caps.mjs` | 静态能力探针：按已安装包判定宿主提供了哪些面 |
| `changelog-extract.mjs` | 从 CHANGELOG 抽取某版本的发布说明（`<tag>`） |
| `session-decode.mjs` / `session-encode.mjs` | `.jsonl.zstd` 多帧容器的解码/编码调试工具（Node 原生 zstd，无依赖） |
| `update-badge.mjs` | 由 vitest JSON reporter 输出更新 shields.io tests 徽章（需 `GIST_TOKEN` / `GIST_ID`；设计为 CI 调用，当前仓库无 CI，未被接线） |

### 2.5 tests/

按主题分四类（共 42 个套件）：

| 类别 | 代表文件 | 关注点 |
| --- | --- | --- |
| 纯逻辑 | `rewind.test.ts`、`candidates.test.ts`、`hidden.test.ts`、`pending.test.ts`、`history.test.ts`、`locales.test.ts` | 目标解析、区间、分区键、文案键完整 |
| 存储与崩溃 | `snapshot.test.ts`、`snapshot-bytes.test.ts`、`crash-safety.test.ts`、`restart-scenario.test.ts`、`downgrade-safety.test.ts`、`undo-restore.test.ts`、`file-cap.test.ts`、`snapshot-mode.test.ts`、`snapshot-cleanup.test.ts` | 字节精确、journal、版本失败关闭、上限、清理 |
| 会话与兼容 | `session-integration.test.ts`、`lifecycle-roundtrip.test.ts`、`compat-invariants.test.ts`、`compat-interop.test.ts`、`compat-gaps.test.ts`、`parent-guard.test.ts`、`compact-compat.test.ts`、`image-offload-projection.test.ts` | surfaceOp 语义、`/compact` 叠加、子代理跳过 |
| 客户端 | `client-*.test.ts`（dom / lifecycle / refill / retract / portal-refresh / composer / confirm / settings-* 等）、`visibility.test.ts`、`log.test.ts`、`chat-channel.test.ts` | portal 挂载、回填守卫、确认框键盘、设置页状态机 |

`tests/support/ui-primitives-stub.ts` 不是测试，而是 `vitest.config.ts` 的 alias 桩：把宿主的重型 primitives 包替换成同契约的轻量实现。

### 2.6 docs/ 与根目录

| 文件 | 内容 |
| --- | --- |
| [docs/README](README.md) | 文档索引、阅读路径、写作约定 |
| [architecture](architecture.md) | 分层、回退流水线、检查点流水线、历史/设置数据流、兼容策略 |
| [format](format.md) | 磁盘格式规范（快照、journal、历史、清理状态） |
| [harness-reference](harness-reference.md) | 用到的 DSH 子系统与源码位置 |
| [compat/audit](compat/audit.md) | 兼容性定义、不变量、U1–U11 开放项、覆盖缺口 |
| [compat/tracking-boundary.zh](compat/tracking-boundary.zh.md) | 文件回退的能力边界（用户可见的限制） |
| [compat/diagnostics.zh](compat/diagnostics.zh.md) | 浏览器诊断开关与异常提示 |
| [snapshot-auto-cleanup.zh](snapshot-auto-cleanup.zh.md) | 清理策略、命令、状态文件 |
| [release/release](release/release.md)、[release/notes-template](release/notes-template.md) | 发版流程与 CHANGELOG 格式 |
| [AGENTS](../AGENTS.md) / [SECURITY](../SECURITY.md) | 协作约定与安全模型 |

---

## 3. 双面插件模型

### 3.1 一个包、两半

DSH 的 bundle 插件可以在同一个 npm 包里同时提供 **host 半**（Node，跑在宿主进程）与 **client 半**（浏览器，跑在 Web 前端）。本包就是一个 row 双面：

```
cordis.patch.yml
  - insert:
      - id: dsh-nonead-prompt-rewind
        name: 'dsh-nonead-prompt-rewind'      # 必须等于包名

package.json
  main     = lib/index.js                     # host 半（ESM）
  exports["./client"] = lib/client.js         # client 半（loader 闭包）
  dsh.bundle.patch    = ./cordis.patch.yml
  dsh.client.inject   = [dsh-client-locale, dsh-client-connection,
                         dsh-client-ui-commands, dsh-client-ui-conversation,
                         dsh-client-ui-settings]
  dsh.client.platform = web
```

要点：

- **row 名必须等于包名**。client-modules 的 node 半会用 `require.resolve('<row-name>/package.json')` 定位包；改名会让浏览器半永远挂不上。
- `dsh.client.inject` 是**包级**加载依赖（保证这些前端包已进模块图）；它**不是** `src/client/index.ts` 里的 `inject` 服务名列表。两者分别解决"包在不在"和"服务几时可用"。
- `exports` 只有四个子路径：`.`、`./client`、`./locale/*.json`、`./package.json`；新增子路径要同步 `tests/package-layout.test.ts`。

### 3.2 host 半能拿到什么

`src/index.ts` 顶部：

```ts
export const name = 'dsh-rewind'
export const inject = ['commands', 'tools', 'settings']
```

其余服务按需动态注入，缺了要能降级：

| 服务 / 事件 | 用途 | 缺失时 |
| --- | --- | --- |
| `commands` | 注册 `/rewind`、`/undo`、`prompt-rewind`、`/snapshot-auto-cleanup` | 插件无法工作；每个命令单独 try/catch，一个重名只损失该命令 |
| `tools` | `tools/execute` / `tools/post-execute` / `tools/result` 钩子 | 捕获不到写前备份，文件还原报告"无变更" |
| `settings` | `describe` 读界面语言、`update` / `mutate` 写清理策略、`configure({auto:false})` 关闭自动生成页 | 清理策略不可读写（fail-closed）、语言退回 `en` |
| `connection`（动态） | 注册 `/dsh-rewind` RPC 路由 | 预览、候选、历史、撤销全部不可用；回退本身仍可用 |
| `fs` + `workingDirectory`（动态） | 解析并 `stat` 写类工具的目标路径、还原后同步观察缓存 | 不记录备份；观察同步降级为空操作 |
| `agents`（RPC 处理内 `scope.get('agents')`） | 由 `sessionId` 解析活动 `Agent` | RPC 返回 `rewind/agents-unavailable` |
| `workspaceRegistry`（`ctx.get`） | 反查会话所属工作区作为历史分区键 | 落入 `_unknown` 分区 |
| `agent/created`、`session/event`（`{ global: true }`） | 会话格式对账、用户消息边界复查 | 不追踪外部改动 |

### 3.3 client 半能拿到什么

```ts
export const inject = ['slots', 'sessions', 'locale', 'commandUi', 'configForms', 'connection']
```

| 服务 | 用途 |
| --- | --- |
| `slots` | 注册 `conversation.session.header.actions`（按钮桥）、`plugins.bundle.config`（配置卡）、`settings.section`（回退历史页） |
| `sessions` | `binding(sessionId)` 取会话面；`list` 判断 main-view 归属；`scope` 取输入作用域 |
| `locale` | `register('rewind', CLIENT_DICTS)`、`bind`、`subscribe` |
| `commandUi` | `decorate({ name: 'rewind' 或 'undo', ... })`：裸命令打开 `popupSelect` |
| `configForms` | `get('dsh-nonead-prompt-rewind')` 取共享表单模型 |
| `connection` | `rpc.call('/dsh-rewind', endpoint, payload, signal)` |

**刻意不注入**的：`uiConversation` 与 `conversation` 都用 `ctx.get(name)` 懒取，每次读都重新取——原因是服务在 live-reload 下会重启，写死注入会让插件在服务缺位时整块失效。读失败一律降级（无 chat → 无按钮/无回填），不抛错。

### 3.4 两半如何通信

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| 命令 `prompt-rewind` | client → host | 执行回退（`/prompt-rewind @<seq>`），走人类命令通道但机器驱动 |
| RPC `/dsh-rewind` | client → host | 预览影响、候选列表、历史、清空、撤销、能力 |
| React 槽位 / chat 快照 | host → client（只读） | 渲染状态与回退 cut |
| 会话日志 | 双向只读 | 目标定位、cut 推导、历史预览 |
| 常量镜像 | 各自硬编码 | `ENGINE_COMMAND`（`src/index.ts` ↔ `src/client/hidden.ts`）、`SETTINGS_ENTRY_ID` |

两半**不共享任何模块**（构建产物是两个独立 bundle），所以 `ENGINE_COMMAND`、包名、设置 entry id 这类字符串在两处各写一份，改动必须成对。

### 3.5 产物与加载

```
lib/index.js          host 半：ESM，`@deepseek-ai/*` 全部 external（宿主解析）
lib/client.js         client 半：CJS 包在 window.__ModuleLoader__.load({ id, factory }) 里
lib/types/**          .d.ts
```

- client bundle 的 external：`react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`（由 web profile 的冻结模块表解析）。
- loader 按 `dsh.client` 声明加载 `./client`，执行闭包工厂拿到 `apply`。
- 从 git 检出直接跑是不行的：源码里没有 `lib/`，必须 `npm run build` 或从 tarball 安装。

---

## 4. 回退机制全链路

### 4.1 四个入口

| 入口 | 路径 | 行为 |
| --- | --- | --- |
| 每条用户消息旁的 ↶ | `portals.tsx` → `openConfirm` → `runRewindAndFill` | 单次确认后执行 |
| 裸 `/rewind`（或 `/undo`） | client 命令装饰 → `popupSelect` | 打开候选面板，选中后进确认框 |
| `/rewind @<seq>` | host `handleRewind` | 直接执行（也接受 `@<seq>` 形式给按钮/引擎用） |
| `/prompt-rewind @<seq>` | 内部引擎命令 | 客户端真正执行时走它，避免与用户命令重名冲突 |

裸命令落到 host 时（非输入框调用者）是一个防御性回退：撤回最新一条用户消息。带第二个 token（如 `chat` / `both`）会被**明确拒绝**（`t('engine.modeRemoved')`）——不会有"只退一半"的路径。

### 4.2 目标解析（`src/rewind.ts`）

```ts
type RewindTarget = { kind: 'seq'; seq: number } | { kind: 'index'; index: number }
```

- `@<n>` → 绝对日志 seq（按钮与引擎总是发这种）。
- `<n>` → 候选列表的 1 基"由新到旧"序号。
- 两者都只接受纯十进制整数：`@1e3`、`@0x10`、`@+5`、裸 `@` 一律非法（避免 `Number()` 的宽松解析）。

`planRewind` 的失败情形与错误码：

| 情形 | 失败码 |
| --- | --- |
| 目标事件存在 | `not-a-user-message` |
| 是**人类**用户消息（`data.source.kind === 'user'`） | `not-a-user-message` |
| 目标仍在 surface 上（未被压缩遮蔽） | `not-on-surface` |
| 序号候选存在 | `invalid-index` |

注入上下文、压缩检查点、工具结果回填都会以 `user/message` 出现但 source 非 `user`；它们不是合法回退边界。

区间计算：`shadowedSeqs = surface.slice(targetIndex)`，`surfaceStart = shadowedSeqs[0]`，`surfaceEnd = 最后一个`。**目标本身也在被撤回区间内**（时间旅行语义：回到这条消息之前，它的文本回填供重发）。候选默认上限 `DEFAULT_CANDIDATE_LIMIT = 100`，与快照的 `MAX_ANCHOR_GROUPS` 对齐。

### 4.3 取消运行与互斥

回退必须在一个"静止"的会话上做，否则追加的 replace 区间会和进行中的写入竞争：

```
inflight.has(sessionId)           → 直接失败（errorCode: inflight）
agent.status !== 'idle'           → agent.cancel({kind:'user'}, {keepInbox:true})
                                    → waitForAgentIdle(agent, signal, 15s)
                                    超时 → 失败（errorCode: stop-failed）
invocation.signal.aborted         → 失败（errorCode: cancelled）
dropPendingSteering(agent)        → 移除 inbox.nextStep 中的待投递插话
```

细节：

- `keepInbox: true`：取消**不**丢弃队列消息；只主动清 `next-step`（steering）——它们属于被回退掉的"未来"，留着会在下一次发送时先被投递。
- `next-turn` 队列**不动**：宿主的 QueueDock 已提供逐条编辑/删除，插件不替用户做决定。
- `waitForAgentIdle` 用 `agent.whenIdle()` 而不是轮询 `status`：`maintenance` 阶段 `status` 也显示 `idle`，只有活动 promise 才能保证写完了。
- 互斥是**进程内、按会话**的 `Set<sessionId>`；它只防同会话并发回退（双击、第二个标签页），不防其它进程改工作区。

### 4.4 标记事件（唯一的日志变更）

```ts
agent.session.append('user/message', buildMarker(), {
  surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
  sourceEventSeqs: [...plan.shadowedSeqs],
})
```

`buildMarker()`：

```ts
createUserMessage({
  content: [{ type: 'text', text: '(empty message)' }],   // 常量，provider 无关
  source: REWIND_MARKER_SOURCE,                            // { kind: 'dsh-rewind' }
})
```

为什么是这个形状：

- **`user/message` 是唯一能携带 `sourceEventSeqs` 的 surface 类型**（surface `replace` 属于引用被遮蔽 seq 的节点）。
- **内容必须非空且常量**：日志 append-only 意味着内容写入即冻结，而会话后续可能换模型服务；严格 OpenAI 兼容网关会拒绝空 user 消息（HTTP 400）。常量占位符到处都能过，且对模型无信息量。
- **不需要 ghost step frame**：token-meter 的 step 机忽略 `user/message`，会话不变量也不要求它有 open turn，所以空闲时一次 append 即可。
- **只遮蔽、不删除**：原始事件仍在日志里，搜索/导出/轨迹面板看得到；只有模型可见 surface 被切。
- 标记的 `surfaceOp` 语义是**不可改写的契约**：改 `op`、改区间含义、或让标记不再是 `user/message`，都会破坏日志重放、`/compact` 叠加与旧日志的可读性。

### 4.5 客户端隐藏

`src/client/visibility.ts` 包装 `uiConversation.views` 中 `target === 'chat'` 的 `definition.create`：

```
RewindVisibilityBuilder
  - 收集所有 command 节点，用 rewindCutsOf 推导每次已执行回退的 cut = [target, marker]
  - 落在任一 cut 区间内的节点 → { ...node, visibility: 'hidden' }
  - 引擎命令自身的 command 行、旧的 preview/__candidates 探针行也隐藏
  - turn-process 汇总行：当该 turn 的成员全被隐藏时一并隐藏
  - cut 集合变化 → 走 replace 全量重建；否则保持 apply 增量路径
```

`visibility: 'hidden'` 是宿主 Chat builder 已有的输入：节点仍在 node store（回填要读文本/图片），但离开 `order`、locations、Turn 导航与分组。副作用之一是右侧轮次导航仍会为已回退轮次保留"未加载"刻度（README 已列为已知问题）。

包装的是**私有 seam**（`uiConversation.views` 是一方注册表，`create()` 不是公开扩展点）：形状要校验、unload 时要恢复原函数并触发已打开会话 rebuild。改动这块必须跑 `visibility.test.ts` 与 `client-*.test.ts`。

### 4.6 输入框回填

`runRewindAndFill`（`src/client/portals.tsx`）是事件驱动的一次性流程：

```
known = 采样已有的 executed-rewind 节点        // 重复回退同一目标时排除旧节点
session.command('/prompt-rewind @<seq>')
等待 waitForCommand(..., 20s)                 // 必须拿到本次新节点的 success
非 success → showHint(宿主理由)，不回填
isMainViewSession 校验                        // 期间切换会话就不回填
text = messageTextAt(chat, seq)               // user 或 steering 节点
images = messageAttachmentsAt(chat, seq)
restoreImages(...)                            // 先补图片（不覆盖已有草稿）
composerText().trim() !== '' → 放弃回填       // 不覆盖用户正在写的草稿
setComposerText(sessionId, text)              // 优先 conversation.input.setDraft，失败退 DOM
```

关键纪律：

- **绝不扫描历史**判断"是否该回填"。会话窗口只加载尾部页，`loadOlder` 会追加更早的命令节点；按快照扫描会把旧回退误判成刚发生（切会话/重启后往输入框塞旧文本）。
- 图片回填走宿主 intake：`readAttachment` 取字节 → `createDrafts` → `input.addAttachments`；`file` 块无法回填（客户端没有文件字节通道）。
- 回填失败只写 `console`（`rewindLog.warn('refill', ...)`），不影响已完成的回退。

### 4.7 历史写入

一次成功回退在返回前**同步等待**一条历史记录落盘（`recordHistoryEntry`）：

- `opId` 与 `at` 与还原 journal 共用，撤销时用同一 id 定位 journal。
- `outcome`：还原有 failed/skipped → `partial`，否则 `success`；早期失败（inflight / stop-failed / cancelled / append-failed）也会写一条 `failed`，`targetSeq` 用 `HISTORY_UNRESOLVED_SEQ = -1`。
- 历史写入**永不抛出**，也**永不改变回退结果**。
- 关闭历史开关（`historyEnabled`）时不写。

### 4.8 预览（RPC `preview`）

确认框打开时异步取影响：

```
preview(sessionId, seq)
  → planRewind（同一条校验链）
  → store.impactsAfter(session.id, targetSeq)   // 只列真正会改变磁盘的动作
  → store.uncoveredPaths(session.id)            // 当前大小已超上限的已追踪路径
  → { files, uncovered, backupOff }
```

客户端最多各列 8 条 restore / delete，超出用 `+N` 汇总；`backupOff` 时额外提示"新快照已关闭，还原可能不完整"。预览失败**不禁用**确认按钮——对话半边仍可回退。

### 4.9 一次回退的完整时序

```
[client] 点击 ↶ / 选中候选
  → openConfirm：preview RPC（异步渲染文件清单）
  → 用户确认（单阶段）
  → runRewindAndFill
      → session.command('/prompt-rewind @<seq>')
[host]   handleRewind → executeRewind
      1. inflight 占位
      2. 运行中则 cancel + waitForAgentIdle(15s)
      3. dropPendingSteering
      4. planRewind（人类消息 + 在 surface 上）
      5. session.append(marker, surfaceOp.replace, sourceEventSeqs)
      6. store.restoreAfter(targetSeq, { opId })  → journal + 逐文件应用
      7. syncRestoreObservations（fs/observed）
      8. recordHistoryEntry（同 opId/at）
      9. 返回 success + 人类可读统计
[client] waitForCommand 拿到 success
  → 读目标文本/图片
  → 空草稿守卫 → 回填
  → visibility 包装器已把 [target, marker] 隐藏
```

---

## 5. 快照机制

### 5.1 语义模型

对齐 Claude Code 的 checkpoint 语义，而不是备份系统：

1. **写前备份**：只追踪 `write` / `edit`；工具真正改文件**之前**把原内容按字节拷走。捕获点选在 `tools/execute`（around-dispatch）而不是 `tools/pre-execute`——前置审批插件返回 `{kind:'ask'}` 会短路后续 pre-execute 监听器，而"被批准"的调用仍要捕获、"被拒绝"的调用绝不能留下记录。
2. **按消息分组的锚点**：条目挂在"最新一条 user/message 的 seq"下。回退到消息 N，就应用**所有锚在 N 及之后**的条目（区间含 N：该回合自身的改动也要退掉）。
3. **每条用户消息边界重扫**：写类工具看不到的外部改动（命令执行、手改、删除）在下一个 user/message 边界被重新 `stat`/比较并记录。
4. **不变不存**：内容与"该路径最近一次记录"一致时不写新副本；写前备份一致时写成指向先前条目的 link（`ref`），而不是复制字节。
5. **还原对照真实磁盘**：`planRestore` 把"每个路径最早的记录"与当前磁盘比较，只对真正不同的路径动手——重复回退幂等，目标状态已达成就零影响。

### 5.2 存储布局

默认根 `<dsh home>/rewind-snapshots/`（`resolveDshHome(config.dshHome)`：`config.dshHome` > `$DSH_HOME` > `~/.dsh`；`snapshotDir` 可整体覆盖）：

```
<root>/<sessionId>/
  store                      # 插件存储格式标记（"2"）
  format                     # DSH 会话格式标记
  <anchorSeq>/<base>.json    # 一条 before 备份的元数据
  <anchorSeq>/<base>.before  # 原始字节 sidecar
  .pending/<base>.before     # 已暂存、未提交的捕获
  rescue/<opId>/<n>.before   # 一次还原前的"救援"副本
  journal-<opId>.json        # 一次还原的意图日志
```

`<base>` = `<safeFileId(callId)>-<sha256(callId)[0..8]>`；`sessionId` 与 `callId` 都被清洗到 `[a-zA-Z0-9._-]`，`.` / `..` 被替换。完整规范在 [format](format.md)。

### 5.3 捕获（`tools/execute`）

`captureBefore` 的判定顺序（每一步都是刻意 fail-closed）：

| 步骤 | 规则 |
| --- | --- |
| 工具名 | 不在 `TRACKED_TOOLS = { write, edit }` 则返回 |
| agent | 无 `exec.agent` → 无法确定锚点，返回 |
| 子代理 | `isSubagentSession` → 返回（见 §10.3） |
| 路径 | 从 `arguments.file_path` 取；类型非 string → 返回 |
| 解析 | `workingDirectory.ensure(agent)` 得 cwd；`fs.resolve(path, {cwd})` 失败 → 返回 |
| stat | 只把 `ENOENT` / `FS_NOT_FOUND` 当"文件不存在"；其它错误（abort、权限、非本地后端）→ 放弃捕获并抛给调用方记录 |
| 非普通文件 | `info.type !== 'file'`（目录、FIFO、设备）→ 不拷 |
| 超上限 | `store.isOverFileCap(info.size)` → **什么都不记**（不是记为"创建"） |
| 字节 | `copyFile` 到 `.pending/`（绝不经过字符串解码，二进制/非 UTF-8 字节精确） |
| 权限位 | 顺带记 `mode & 0o7777`，尽力而为 |

一个捕获挂在 `pending` 里，键是 `"<agentId|anon>:<callId>"`。`tools/result` 是安全网：`tools/execute` 瀑布里别的包装器抛错会跳过 `post-execute`，这里无条件丢弃暂存字节（幂等）。

### 5.4 提交（`tools/post-execute`）

```
未在 pending 中            → return（未追踪）
开关在捕获与提交之间关掉    → discard
result.isError             → discard（失败的调用绝不进存储）
无 agent / 无 anchor       → discard
anchorSeq = anchorSeqOf(session)   // 自最近一次计算以来只扫新增事件，WeakMap 缓存
store.recordBackup(sessionId, {callId, anchorSeq, path}, backup)
  → 成功后把 path 加入 trackedBySession（供边界复查）
```

`recordBackup` 内部把 `.pending/` 的字节 `rename` 进锚点目录（同一文件系统，原子），再写元数据；顺序保证"可能留下未被引用的 sidecar，但绝不会出现引用了缺失字节的条目"。

### 5.5 边界复查（`session/event` + `user/message`）

`reconcileTracked` 是外部改动的唯一入口：

- 跳过子代理会话；回退进行中（`inflight`）跳过——`executeRewind` 的 append 会**同步**触发该监听器，此时 `restoreAfter` 正在写同一批文件，跑一遍会记录撕裂状态；下一次真实边界会重新推导，不丢信息。
- 对每个 tracked 路径：`lstat` 链接检查 → 超上限跳过（不读字节）→ 与 `lastKnownContent` 比较 → 只有变化（或从未记录）才记录。
- 记录的 `callId = recheck-<anchorSeq>-<hashPath(path)>`，`dedup: false`（变化态不可能命中 link）。
- `probe` 失败 → 跳过该文件，绝不记为"不存在"。

`lastKnownContent` 与 `recordEntry` 的去重共用**同一个**内存句柄，所以每个决策只有一次比较、一份内容。

### 5.6 还原

`restoreAfter` = `planRestore` + 逐动作应用。`planRestore` 规则：

| 记录 | 磁盘 | 动作 |
| --- | --- | --- |
| `before: null`（创建） | 存在 | `delete` |
| `before: null` | 不存在 | 无操作（目标已达） |
| `before: 字节` | 与记录不同 / 缺失 | `restore` |
| `before: 字节` | 相同 | 无操作 |
| `lossy`（旧格式丢字节） | 任意 | 只比较；不同则 `skipped`，**永不写回** |
| 符号/硬链接 | — | `skipped` |
| 父目录 pin 不匹配 | — | `skipped` |
| 当前大小超上限 | — | `skipped`（写回更小内容会毁掉现文件） |
| 记录不可解析 / sidecar 缺失 | — | `failed`，**绝不当 delete** |
| 探测抛错 | — | 保守当作"不同"，仍尝试写/删 |

其余细节：

- 只检查路径最后一段是否为链接；**目录 pin**（提交时 `realpath(dirname)`）防"父目录被改指向"把写入引出记录位置。父链被删仍可重建，但只在最近的存活祖先仍落在 pin 内时。
- 每个失败是**单文件**失败，永不中止整轮。
- 需要 `delete` 而文件已不在 → 静默无操作（不是失败）。
- 内容写回时顺带 `chmod` 记录权限位；仅有 mode 差异不构成动作。

### 5.7 崩溃安全与恢复

顺序：

```
1. 计划（对照磁盘）
2. 捕获每个计划路径的 rescue（还原前状态）
3. 原子写 journal（intent），状态 running
4. 逐动作应用，每步标记 done 并重写 journal
5. 全部成功 → state = completed
```

崩溃后 API：

| API | 作用 |
| --- | --- |
| `reconcileRestores(sessionId)` | 读所有非终态 journal，**以真实磁盘为准**报告 restored / pending / failed；目标已达则自动治愈为 `completed` / `rolled-back` |
| `continueRestore(sessionId, opId, deleteFile)` | 只补"磁盘还没到目标"的动作；已在目标的不重写 |
| `rollbackRestore(sessionId, opId, deleteFile)` | 按 rescue 回到还原前状态；`running → rollback-running → rolled-back`，失败留 `recovery-required`（可重试） |
| `undoRestore(sessionId, opId, deleteFile)` | 用户可见的"恢复到回退之前"：只接受 `completed` journal，且所有已应用路径必须仍等于**还原后**状态，否则整批拒绝（`stale-undo`） |

纪律：

- **插件自己从不调用这些恢复 API**：中断的操作保持中断，直到明确有人继续或回滚。
- 损坏的 **journal** 报告 `recovery-required`，绝不静默删除（删掉就没了恢复记录）；损坏的 **条目** 静默忽略（只丢一条备份）。
- journal IO 失败时降级为"无 journal 的还原"：行为不变，只是失去崩溃保护。

### 5.8 上限与 prune

| 上限 | 值 | 行为 |
| --- | --- | --- |
| 单文件备份 | `DEFAULT_MAX_FILE_BYTES = 8 MiB`（`maxFileBytes`，`0` 关闭） | 超限不备份、不记录；还原侧也拒绝写回 |
| 每会话锚点组 | `MAX_ANCHOR_GROUPS = 100`（`maxAnchorGroups`） | `prune` 逐出最旧组 |
| 暂存捕获 | 24h | `prune` 收集 `.pending/` 里的过期残留 |
| 终态 journal | 保留到下次 `prune` | `pruneTerminalJournals` 回收 journal 与 `rescue/<opId>/` |
| 非终态 journal | 不回收 | 其引用的锚点组被 **pin**，因此窗口可暂时超过 100 |

`prune` 的顺序要点：

1. 先回收终态 journal、清理过期 pending，再做锚点组逐出（这两件事与会话是否超限无关）。
2. 逐出前先 `pinnedAnchors`：非终态 journal 还需要它引用的 sidecar，那组不许删。
3. 被保留的 link 若指向即将删除的组，先**物化**（把字节复制到自己旁边并改写为真实条目）再删，绝不留悬空 link；物化写失败则**在删除任何东西之前中止**。
4. 删组后清掉该会话的去重内存状态，下一次提交重新从存活窗口 seed。

跨会话清理（默认关闭）见 §6.8 与 [snapshot-auto-cleanup.zh](snapshot-auto-cleanup.zh.md)。

### 5.9 版本守卫（双向）

- `CURRENT_STORE_VERSION = 2`；每个会话目录有 `store` 标记，每条条目也带 `store` 字段。
- 读到**更新**版本（`UnknownStoreVersionError`）：文件还原整体失败关闭（不改任何文件、不写新条目），**对话回退仍然成功**；`impactsAfter` 也拒绝。
- 读到旧版本（缺失或 `1`）：按已发布的旧字符串格式只读兼容；`lossy` 记录只比较不写回。
- DSH **会话**格式变化：`agent/created` 时 `reconcileFormatVersion(sessionId, header.version)`——标记不一致或缺失但有内容 → 清空该会话快照目录，然后重盖章（避免 seq 被迁移错位）。这里必须**先**跑存储版本守卫，否则会把新版快照一起清掉。
- 明确的删除（`run --current --apply`、按龄清扫）**不**受版本门禁——那是用户主动的整目录删除。

### 5.10 还原后的观察缓存同步

还原用裸 `node:fs` 写/删，绕过 harness 的 fs-observation-policy；不同步的话，同一会话对刚还原/删除的文件的**下一次写**会拿还原前的旧观察判 `write` 意图，被 `fs-local` 以 `FS_STALE_VERSION` 拒绝。

`syncRestoreObservations` 用宿主自己的公开事件补齐：

```ts
ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
ctx.emit('fs/observed', target, { kind: 'present', version }, { agent })
```

只修复"还原自身造成的"不一致；之后的外部改动照旧触发 stale 保护。

### 5.11 失败行为总表

| 场景 | 对话 | 文件 | 上报 |
| --- | --- | --- | --- |
| 快照开关关闭 | 正常回退 | 不捕获、不还原新改动 | 结果追加"备份已关闭" |
| 存储版本更新 | 正常回退 | 失败关闭（什么都不改） | `storeUnsupported` |
| 单个文件写失败 | 已完成 | 其余文件继续 | `failures.item` 逐条列出 |
| 文件当前超上限 | 已完成 | 该文件 skipped | `skipReason.oversized` + 路径 |
| 目录被改指向 | 已完成 | 该文件 skipped | skipped 计数 |
| 目标被压缩遮蔽 | 拒绝 | — | `not-on-surface` 文案 |
| 子代理会话 | 无回退面 | 不追踪 | — |

---

## 6. 历史与设置页

### 6.1 分区键：谁能看见哪段历史

历史按**工作区**分区，且分区键**由 host 推导**，客户端从不传 key——跨工作区读取在构造上不可能：

```
workspaceKeyFromRegistry(sessionId, workspaces)
  命中 → "ws-<workspaceId>" + { workspaceId, path }
  未命中 → "_unknown"（不回退到猜路径；Session 上没有可信 cwd）
```

`safeKeySegment` 清洗段名，`cwdKey(path)`（`cwd-<sha256(realpath)[0..12]>`）是给其它调用者的工具，插件当前在注册表缺失时用 `_unknown` 而不是 cwd 猜测。

### 6.2 文件与不变量

根：`<dsh home>/rewind-history/`，若 `snapshotDir` 被显式配置则取 `<snapshotDir>/../rewind-history`。

```
<root>/<workspaceKey>/history.json     # version 1, { workspace, entries[] }
```

不变量：

- 一个分区一个文件；读-改-写走**按路径串行**的 promise 队列；写入 tmp + rename → 永不半写。
- 分区最多 `historyLimit` 条（默认 10，范围 1–100）；溢出在同一次写里 `splice` 掉最旧的。
- 分区文件硬上限 512 KB；超了从最旧开始裁，而不是让文件无限长。
- 损坏/未知版本：改名 `history.json.corrupt-<epoch>` 留证据，再换成空分区——绝不静默删除。
- 条目除撤销记账字段（`undoneAt` / `undoOutcome` / `undoMode`）外不可变；`undoneAt` 最多设置一次。
- `dispose()` 会停止接收新写并等待在途写：否则卸载时后台 append 会和数据目录拆除竞争（Windows 上表现为 `ENOTEMPTY`）。

每条记录的关键字段：`opId`、`workspaceKey`、`sessionId`、`at`、`targetSeq`、`hadFiles`、`outcome`、`shadowedEvents`、`messagePreview`（≤80 字符）、`files{restored,deleted,skipped,uncovered,preview≤20}`、`errorCode/errorText`、`chainPrev`、`undoable`、`undoneAt`。

### 6.3 链尾撤销与 stale 拒绝

一次回退最多撤销一次，且只能撤**当前会话、当前分区里最新且未撤销**的那条（链尾）。RPC `undo` 的校验顺序（顺序即语义）：

| # | 检查 | 失败码 |
| --- | --- | --- |
| 1 | payload 有 `sessionId` / `opId` | `rewind/bad-request` |
| 2 | agents 注册表可用 / 会话已挂载 | `agents-unavailable` / `session-not-found` |
| 3 | 条目在该工作区分区里 | `unknown-entry` |
| 4 | `entry.workspaceKey === 当前分区` | `undo-cross-workspace` |
| 5 | `entry.sessionId === 当前会话` | `undo-other-session` |
| 6 | 未撤销过 | `already-undone` |
| 7 | `entry.undoable`（journal + rescue 还在） | `not-undoable` |
| 8 | 是链尾（`HistoryStore.isChainTail`） | `undo-not-top` |
| 9 | `undoRestore`：已应用路径仍等于还原后状态 | `stale-undo`（附 `stalePaths`） |
| 10 | 其它还原异常 | `undo-failed` |

撤销**只还原文件**：对话回不来（`foldSurface` 已把节点移出 surface）。成功后 `patch` 条目写入 `undoneAt` / `undoOutcome` / `undoMode: 'files'`。

"stale 拒绝"是本功能的安全核心：回退后又手改过其中某个文件，整批撤销被拒绝，而不是覆盖用户的改动。

### 6.4 能力上报（`caps`）

`caps` 返回 `{ history, undo, fileCheckpointing }`。设置页在任一为 `false` 时显示一行降级提示——把"宿主缺什么"说出来，而不是假装功能完好。这比"全挂"更符合可诊断性要求。

### 6.5 设置页（`settings.section`，id `rewind`）

- 注册：`slots.inject('settings.section', ...)`，`id: 'rewind'`，`order: 60`（在内置 market 40 与 desktop 100 之间），`label: t('settings.nav')` = 中文「回退历史」。
- 页面内容：工作区标题、刷新/导出 JSON/清空（二次确认）、历史列表（outcome 徽章、相对时间、`@targetSeq`、预览、文件数、撤销按钮）、能力降级提示、配置卡片嵌入。
- 撤销按钮只在 `entry.undoable && undoneAt === undefined && entry.opId === tailOpId` 时出现。
- 数据全部走 RPC（`history` / `history.clear` / `undo` / `caps`），页面从不读磁盘。
- 会话切换会让页面重新加载（`currentSessionId` 变化 → `reload`），并用 `loadSeq` 丢弃过期响应，避免显示上一个工作区的列表。
- 主题：所有颜色来自 `dsw` token 的 `dsh-rewind-*` class，无内联颜色。

### 6.6 插件配置卡（`plugins.bundle.config`）

- 注册 key = `PLUGIN_PACKAGE`（包名），locale namespace = `rewind`。
- 三个可编辑项：`fileCheckpointingEnabled`（默认开）、`autoCleanupEnabled`（默认关）、`autoCleanupMaxAgeDays`（默认 30）。
- 设置页与 Plugins 页**共用同一个** `SettingsFormModel` 与同一份草稿：一处编辑，另一处不会丢。
- 表单不可用（宿主没有 `configForms`）时两个配置入口一起禁用，回退功能不受影响。
- 注册失败只写日志：配置面与回退能力解耦。

### 6.7 配置项（`Config` schema）

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `snapshotDir` | 未设 | 快照根路径（覆盖默认推导） |
| `dshHome` | 未设 | 覆盖 harness home，影响默认快照/历史/清理状态路径 |
| `dedup` | `true` | 相同 before 内容存 link |
| `maxFileBytes` | `8388608`（8 MiB） | 单文件备份上限，`0` = 不限 |
| `maxAnchorGroups` | `100` | 每会话保留的最新锚点组 |
| `autoSweepIntervalMs` | `86400000` | 自动清扫节流窗口 |
| `fileCheckpointingEnabled` | `true`（volatile） | 新备份开关 |
| `autoCleanupEnabled` | `false`（volatile） | 自动清扫开关 |
| `autoCleanupMaxAgeDays` | `30`（volatile） | 失活天数阈值 |
| `historyEnabled` | `true`（volatile） | 是否写历史 |
| `historyLimit` | `10`（volatile，1–100） | 每工作区保留条数 |
| `historyPreview` | `true`（volatile） | 历史里是否存消息预览 |

`volatile()` 字段由宿主的 Plugins 页实时解析；`apply` 里 `settings.configure({ auto: false }, ctx.fiber)` 表示本插件自己提供配置卡，不让宿主自动生成页面。

清理策略的持久化：`volatileCleanupStore` 把 `{enabled, maxAgeDays}` 映射到上面两个字段；写等于默认值时会 **clear** 该字段（重新继承 schema 默认），而不是钉住一份副本；写入前用 `parseCleanupConfig` 再校验一次（schema 之下的纵深防御）。

### 6.8 自动清扫

- 触发：每个 mount 的**第一次**会话活动（用户消息或工具结果）做一次检查；读策略 + 磁盘上的 `lastSweepAt`，只在开启且超过 `autoSweepIntervalMs` 时执行，随后把时间写回 `<dsh home>/snapshot-cleanup-last-sweep.json`（跨重启保持节流）。
- 子代理会话的工具结果**不**触发（它没有快照目录，却会抢占"活动会话豁免"，让真正的父会话失去保护）。
- 清扫只删整目录：`lstat`（不跟随链接）、跳过点前缀临时物、永不删活动会话。
- `maxAgeDays <= 0` 直接抛错，而不是退化成"未来 cut-off 全删"。
- 手动入口 `/snapshot-auto-cleanup status|on|off|max-age <days>|run [--apply] [--current]`；`--apply` 是唯一的执行开关，无它即预演。

---

## 7. 构建与测试链路

### 7.1 命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 全检：`typecheck` → `build` → `test` → `verify:host` → `npm pack --dry-run` |
| `npm run typecheck` | 三套 tsconfig（host / client / client-test） |
| `npm run build` | esbuild 产物 + `.d.ts` |
| `npm test` | vitest 全量 |
| `npm run verify:host` | 端到端宿主验证 |
| `npm pack --dry-run` | 看发布清单（`prepack` 会先 build） |

### 7.2 类型检查的三套配置

```
npm run typecheck
  = tsc --noEmit -p tsconfig.json          # host 源码 + 大多数 tests
  && tsc --noEmit -p tsconfig.client.json  # client 半（emitDeclarationOnly 不落盘）
  && tsc --noEmit -p tsconfig.client-test.json  # client 测试 + support 桩
```

另外两套只在 build 里用：`tsconfig.build.json`（host `.d.ts` → `lib/types`）、`tsconfig.client.json`（client `.d.ts` → `lib/types/client`）。公共选项在 `tsconfig.base.json`：strict、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`allowImportingTsExtensions`。

`tsconfig.json` 的 `exclude` 刻意排除 `tests/client-*.test.ts` 与 `tests/support/**`：它们是 DOM/JSX 环境，归 `tsconfig.client-test.json`。

### 7.3 build.mjs 的步骤

1. `rm -rf lib/`（防止旧模块的 `.d.ts` 残留进包）。
2. `tsc -p tsconfig.build.json` → `lib/types/*.d.ts`。
3. `tsc -p tsconfig.client.json` → `lib/types/client/*.d.ts`。
4. esbuild host：`src/index.ts` → `lib/index.js`，`format: esm`、`platform: node`、`target: es2024`、`external: ['@deepseek-ai/*']`。
5. esbuild client：`src/client/index.ts` → 临时 `lib/_client.js`，`format: cjs`、`platform: browser`、`target: es2020`、`external: ['react','react-dom','react/jsx-runtime','@deepseek-ai/dsh-client-ui-primitives']`、`jsx: automatic`、`define` 注入版本与 client 源码内容哈希。
6. 包装成 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... } })` 写 `lib/client.js`，删除临时文件。
7. 冒烟检查：host 必须导出 `name`/`inject`/`apply`；host 不得静态 import `settingsNamespace`（DSH 0.1.2 已移除，会整包 link 失败）；client 必须含 loader 包装与 boot 身份行；`__DSH_REWIND_*__` 不得泄漏到产物；两个 `.d.ts` 必须存在。

### 7.4 vitest

- `vitest.config.ts`：`environment: 'node'`，`include: ['tests/**/*.test.ts']`。
- alias 把 `@deepseek-ai/dsh-client-ui-primitives` 指到 `tests/support/ui-primitives-stub.ts`（真包会拖入 shiki/anser 等 shell 才有的重依赖）。类型仍来自真包声明。
- 42 个套件，分类见 §2.5。
- 客户端套件跑在 node 环境里，用 `jsdom`（devDependency）或手搓的 DOM 替身，不启动浏览器。

### 7.5 verify-host

真 `Context` + 真 `Session` + 临时目录（`mkdtemp`），把 `snapshotDir` 指到临时目录，文件是真实磁盘文件。它是**产物级**验证：import 的是 `lib/index.js`，不是 `src/`。

分 17 组（约 130 个 `check(...)` 断言点）：

| 组 | 覆盖 |
| --- | --- |
| 1 | 四个命令注册、`/undo` 与 `/rewind` 共用 handler、引擎命令拒绝裸调用 |
| 2 | 裸 `/rewind` 撤回最新消息；日志 5 条（4 seed + 1 marker）；标记形状断言 |
| 3 | `@<seq>` 参数形式切 surface、日志仍 append-only |
| 4 / 4b–4l | 写前备份与还原：真文件内容、创建文件删除、二进制字节精确、新版存储失败关闭、权限位、上限、非普通文件不捕获、service stat 错误不算"创建"、`edit` 也被追踪、开关关闭、父目录 pin 与稳定 symlink 祖先、abort 不等于不存在 |
| 5 | 被拒绝的调用不留条目 |
| 6 | 相对路径按会话 cwd 解析 |
| 7 | 无记录的预览报告"无变更" |
| 8 / 8b | 运行中 agent 被强制停止；空闲时 pending steering 被丢弃 |
| 9 | 取消后永不静止 → 回退中止（超时路径） |
| 10 | 子代理编辑不被追踪 |
| 12 / 12b / 13 / 14 | 真 `/compact` 叠加在回退标记之上仍可重放；重复回退 + 真回合 + `/compact` 的记账平衡；回退到被压缩遮蔽的消息被拒绝 |
| 15 | `/snapshot-auto-cleanup` 查看/配置/预演/执行/`--current` |
| 16 | 删数据目录只清文件备份，对话仍可回退 |
| 17 | `/plan text` 回退只撤消息，不动 plan-mode 状态 |

### 7.6 打包布局

- `files` 是 allowlist：`lib`、`cordis.patch.yml`、`docs/DETAIL.md`、`docs/DETAIL.zh.md`、`SECURITY.md`、`locale/*.json`、`assets/icon.svg`。
  两张详情页正文（DETAIL / DETAIL.zh）是纯文字，不再携带配图，因此也没有配图校验脚本。
- 仓库专用文档**不进包**：`docs`（目录级）、`assets/screenshots`、`CHANGELOG.md`。本指南与 PLAN 也不在发布内容里。
- `tests/package-layout.test.ts` 守护：清单、exports 目标存在、host bundle 的 import 只能 `@deepseek-ai/*` 或 `node:`、devDependencies 无本机路径、`engines.node`、以及 `engines.dsh` 与 peer tuple 的边界必须匹配（窄界 `<nextminor>.0-0` 或宽界 `<nextminor>.1-0`）。
- `@deepseek-ai/*` 全部 external：tarball 不携带它们，由宿主解析。

---

## 8. 本地调试

### 8.1 浏览器日志开关

键：`localStorage['dsh-rewind.debug']`（每个 origin 独立）。

| 值 | 效果 |
| --- | --- |
| 未设 / 空 | 只有 `error` / `warn` |
| `dsh-rewind*` 或 `*` | 全部命名空间 |
| `dsh-rewind:refill` | 只有回填相关 |
| `dsh-rewind:refill,dsh-rewind:portals` | 多选（逗号分隔） |

- `error` / `warn` **永远**输出（异常守卫：少见、便宜、不该被开关藏起来）。
- `info` / `debug` 走 `console.info` 而非 `console.debug`（后者被 Chrome 默认的 Verbose 过滤挡掉）。
- 开关**每次调用现读**，不缓存：改完 localStorage 刷新页面即可生效，不需要重装插件。

### 8.2 启动身份行

client 半每次加载输出一行：

```
[dsh-rewind:boot] loaded v0.5.1 (build <8 位源码哈希>)
```

用于回答"我跑的是不是修好的那个包"——最常见的根因（缓存/没重启/装的是旧 tarball）一眼排除。哈希由 `build.mjs` 对 `src/client/**` 全部内容计算，因此改任一 client 文件都会变。

### 8.3 能力探针

```sh
node scripts/probe-caps.mjs          # 人类可读
node scripts/probe-caps.mjs --json   # 机器可读
```

按**已安装**的 `@deepseek-ai/*` 判定：`surfaceOp`、`rpc`（核心）、`toolsHooks`、`workspaceRegistry`、`settingsSection`、`configForms`、`uiConversationViews`（可降级）。依赖没装时输出 `PROBE-SKIPPED` 且 `caps: unknown`——**"未知"不等于"缺失"**，别误判。

### 8.4 单测定位

```sh
npx vitest run tests/snapshot.test.ts
npx vitest run tests/client-refill.test.ts
npx vitest run -t "marker"            # 按用例名过滤
npx vitest --reporter=verbose         # 看每个 it
```

排查顺序建议：纯函数（`rewind`/`candidates`/`hidden`）→ 存储（`snapshot*`）→ 会话/兼容（`session-integration`/`compat-*`）→ 客户端（`client-*`）。

### 8.5 verify-host 单跑

```sh
npm run build && node scripts/verify-host.mjs
```

它失败时是**真实磁盘与真实 Session** 的问题，优先信它。常见原因：`lib/` 是旧产物（重跑 build）、临时目录权限、Windows 上文件被占用。

### 8.6 症状 → 定位

| 症状 | 先看 |
| --- | --- |
| 按钮不出现 | `dsh-rewind.debug=dsh-rewind:portals`；`conversation.session.header.actions` 槽位是否注册；chat 快照是否拿到 |
| 回退报错"目标不在模型上下文" | 目标被 `/compact` 遮蔽（`not-on-surface`）——预期行为 |
| 回退后文件没变 | 预览是否为空；`fileCheckpointingEnabled`；该文件是否超 8 MiB；是否从未被 `write`/`edit` 碰过 |
| 输入框没回填 | `dsh-rewind:refill`：命令是否 success、草稿是否非空、是否 main-view 会话 |
| 撤销被拒 | 看错误码：`undo-not-top`（先撤更新的）、`stale-undo`（回退后又改过文件） |
| 设置页显示降级提示 | `caps` 字段为 `false` → 宿主缺对应服务，不是插件 bug |
| 桌面/其它窗口行为异常 | 插件按会话工作，检查是否在子代理会话里（无回退面） |

---

## 9. 扩展点

### 9.1 新增界面语言

1. 在 `src/locales.ts` 加一份 `HostKey` 完整字典并登记进 `HOST_DICTS`；
2. 在 `src/client/locales.ts` 加一份 `RewindKey` 完整字典并登记进 `CLIENT_DICTS`；
3. 加 `locale/<tag>.json`（`meta.title` / `meta.description`，两空格 JSON + 末尾换行，`tests/package-layout.test.ts` 会逐文件校验格式）；
4. 可选：给插件详情页补配图（`docs/preview.<tag>.svg`），否则回退英文图。

无其它接线：类型会让缺键/多键直接编译失败。

### 9.2 新增受追踪工具

`TRACKED_TOOLS` 与 `mutationPathOf` 是唯一判定点。加工具时要同时确认：

- 参数里没有 `file_path` 的工具需要扩展 `mutationPathOf`；
- 捕获/提交/边界复查/预览/结果文案都要能被覆盖（现有测试对 `write` 与 `edit` 各有断言）；
- 若工具**删除**文件，`before` 记录与"创建"语义相反，必须补 `planRestore` 的用例与 verify-host 断言。

### 9.3 新增 RPC 端点

1. `createRewindRpcHandler` 里加 endpoint 分支（payload 校验 → 取 session → 返回 `{ok:true,value}` 或 `rpcFailure(code,msg)`）；
2. `src/client/host-rpc.ts` 加一个 `*OverRpc` 包装（超时、结果形状校验、失败降级）；
3. 客户端入口把需要的服务注入到槽位（如设置页 `inject()`）；
4. 端点名写进本文与 `compat/audit.md` 的相关条目；`verify-host` 补一条断言。

### 9.4 改清理策略

策略纯函数在 `src/snapshot-cleanup.ts`（可脱离宿主单测）；命令语法在 `parseCleanupCommand`；状态文件路径在 `resolveCleanupStatePath`。改字段要同步：`Config` schema、`volatileCleanupStore` 的映射、配置卡字段、[snapshot-auto-cleanup.zh](snapshot-auto-cleanup.zh.md)。

### 9.5 改客户端 UI

- 任何新 UI 都要落在既有槽位（`settings.section` / `plugins.bundle.config` / `conversation.session.header.actions`）里，不要自己 append 到 body（确认框是唯一例外：一个自定位、自销毁的 dialog，且必须成对 `closeConfirm`）。
- 文案一律进 `CLIENT_DICTS`，颜色一律用 `dsw` token。
- 新增 class 名要进 `styles.ts`。

---

## 10. 红线

### 10.1 会话与日志

1. **append-only**：绝不 `delete`/`rewrite` 已记录事件；回退只能是"追加一个标记"。
2. 标记的 `surfaceOp` 语义、`sourceEventSeqs` 引用、`user/message` 类型、内容常量**都不许改**——它们同时被日志重放、`/compact` 叠加和旧日志读取依赖。
3. 不得为回退引入 ghost step/turn 帧；标记在空闲时单事件追加。
4. 目标必须是**人类** `user/message` 且在 surface 上；不要放宽到注入上下文。

### 10.2 文件安全

1. 路径必须经 `safeSessionId` / `safeFileId` 清洗才能进存储根；`..`、绝对路径、链接引用都要拒绝。
2. 只用记录过的路径（会话自己的写类工具 + 对该集合的边界复查）；绝不从外部输入拼路径去写。
3. 符号链接/硬链接路径不写、不删、不透过。
4. 记录不可解析时是**单文件失败**，不是删除。
5. 上限的"安全半边"不能省：当前文件超上限时宁可 skipped，也不能用手上更小的旧内容覆盖它。
6. 还原/清理/删除全部限制在存储根内，遍历用 `lstat`，不跟随链接。

### 10.3 作用域

1. **不追踪子代理会话**，也不在子代理里提供回退面（`isSubagentSession` 是唯一判定点：捕获、边界复查、`agent/created` 对账、自动清扫触发）。
2. 历史分区由 host 推导；客户端不许传 partition key。
3. 撤销只对链尾、只一次、只还原文件。

### 10.4 工程

1. 不改 `exports` 子路径而不更新 `tests/package-layout.test.ts`。
2. 不让 `@deepseek-ai/*` 进 bundle（必须 external）；不在 host bundle 静态 import 已被移除的导出。
3. 不依赖 git、网络或凭据。
4. 每个改动都要过 `npm run check`；提交保持"一个逻辑变更一个 commit"（见 [AGENTS](../AGENTS.md)）。
5. 文档事实以源码/`package.json`/测试为准：本文件里出现的版本、上限、命令、路径若与代码不一致，改文档。

---

## 附录 A：文件与职责速查

| 你要改的东西 | 文件 |
| --- | --- |
| 回退语义/错误码 | `src/rewind.ts` |
| 标记形状 | `src/marker.ts` + `src/index.ts` 的 `buildMarker` |
| 执行顺序/取消/互斥 | `src/index.ts` 的 `executeRewind` |
| 捕获/提交/边界复查 | `src/index.ts` + `src/snapshot.ts` |
| 还原计划/journal | `src/snapshot.ts` |
| 历史/撤销 | `src/history.ts` + `src/index.ts` RPC |
| 清理策略 | `src/snapshot-cleanup.ts` |
| 命令文案 | `src/locales.ts` |
| 按钮/回填 | `src/client/portals.tsx` |
| 隐藏区间 | `src/client/hidden.ts` + `src/client/visibility.ts` |
| 确认框 | `src/client/confirm.ts` |
| 设置页 | `src/client/settings-section.tsx` |
| 配置卡 | `src/client/settings-card.tsx` |
| RPC 客户端 | `src/client/host-rpc.ts` |

## 附录 B：命令与端点速查

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 命令 | `/rewind` | 裸调用打开候选；`@<seq>` 直接执行 |
| 命令 | `/undo` | `/rewind` 的别名（同一 handler） |
| 命令 | `prompt-rewind` | 内部引擎通道，裸调用被拒绝 |
| 命令 | `/snapshot-auto-cleanup` | `status` / `on` / `off` / `max-age <days>` / `run [--apply] [--current]` |
| RPC | `preview` | `{sessionId, seq}` → `{files, uncovered, backupOff}` |
| RPC | `candidates` | `{sessionId}` → `{candidates}` |
| RPC | `history` | `{sessionId}` → `{workspace, entries}` |
| RPC | `history.clear` | `{sessionId}` → `{cleared}` |
| RPC | `undo` | `{sessionId, opId}` → `{kind, restored, deleted, failed}` |
| RPC | `caps` | `{sessionId}` → `{history, undo, fileCheckpointing}` |

## 附录 C：术语

| 术语 | 含义 |
| --- | --- |
| surface | 模型可见的有序节点序列（`session.surface.nodes`） |
| marker | 回退追加的那条 `user/message` 事件 |
| cut | 一次已执行回退的 `[target, marker]` 区间 |
| anchor | 一次写前备份挂靠的用户消息 seq |
| before-backup | 写前字节副本（`<base>.before` + 元数据） |
| rescue | 还原前捕获的状态，用于回滚 |
| journal | 还原意图日志，崩溃恢复的凭据 |
| link / 去重条目 | 指向先前条目的 `ref`，避免重复存同样字节 |
| 链尾 | 当前会话最新、尚未撤销的回退记录 |
| 分区 | 一个工作区的历史文件 |

## 附录 D：文档地图

本仓库的文档边界是"一题一处"：

- 用户行为 → [README](../README.md)
- 分层与流水线 → [architecture](architecture.md)
- 磁盘格式 → [format](format.md)
- 宿主接口 → [harness-reference](harness-reference.md)
- 兼容性与开放项 → [compat/audit](compat/audit.md)、[compat/tracking-boundary.zh](compat/tracking-boundary.zh.md)
- 诊断 → [compat/diagnostics.zh](compat/diagnostics.zh.md)
- 清理 → [snapshot-auto-cleanup.zh](snapshot-auto-cleanup.zh.md)
- 发布 → [release/release](release/release.md)、[release/notes-template](release/notes-template.md)
- 路线图 → [DEVELOPMENT-PLAN.zh](DEVELOPMENT-PLAN.zh.md)
- 变更历史 → [CHANGELOG](../CHANGELOG.md)
