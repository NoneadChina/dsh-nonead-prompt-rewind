# 开发计划：当前状态与后续路线图

> 本文件描述 **0.5.1** 的基线与下一步工作，不记录已完成的过程叙事。
> 机制细节见 [开发指南](DEVELOPMENT-GUIDE.zh.md)；变更历史见 [CHANGELOG](../CHANGELOG.md)；
> 兼容性结论见 [compat/audit](compat/audit.md)。

## 1. 当前基线

| 项 | 现状 | 事实来源 |
| --- | --- | --- |
| 版本 | `0.5.1` | [package.json](../package.json) |
| 定位 | 同窗口就地回退对话 + 写前快照还原工作区文件 | [README](../README.md) |
| 包形态 | 双面插件（host `lib/index.js` + client `lib/client.js`），一个 bundle row | `cordis.patch.yml`、`package.json` |
| 运行环境 | Node `>=24.9.0`，DSH `>=0.2.1-0 <0.3.1-0` | `engines` |
| 能力面 | 4 个命令、6 个 RPC 端点、3 个 UI 槽位、8 种界面语言 | `src/index.ts`、`src/client/index.ts` |
| 交互 | 单阶段确认（无模式选择），对话与文件同时回退 | `src/client/confirm.ts`、`src/index.ts` |
| 存储上限 | 单文件 8 MiB、每会话 100 个消息组、每工作区 10 条历史 | `src/snapshot.ts`、`src/history.ts` |
| 测试规模 | 42 个 `*.test.ts`；`verify-host` 17 组 | `tests/`、`scripts/verify-host.mjs` |
| 全检命令 | `npm run check`（typecheck + build + test + verify:host + pack --dry-run） | `package.json` |
| 验证基线 | devDependencies 钉 `0.2.2-alpha.2` | `package.json`、[compat/audit](compat/audit.md) |
| 发布自动化 | **缺失**：仓库没有 `.github/workflows/` | 仓库根目录 |
| 文档 | README 中英 + AGENTS + SECURITY + docs/ 17 篇 Markdown；相对链接为手动维护 | `docs/README.md` |

### 已知缺口

1. **没有 CI，发布全靠手动**：仓库没有 `.github/workflows/`；[release/release.md](release/release.md) 已如实写明"手动发布、Trusted Publisher 未配置"，因此每次发布都依赖本地 `npm run check` 与人工步骤。另有一处发布前置问题：`scripts/changelog-extract.mjs` 对当前 `CHANGELOG.md` 的 `0.5.1` 块校验失败（`Full Changelog` 行不是独占一行的 URL），发布前必须先修 CHANGELOG 块。
2. **0.2.1 线未逐版本验证**：`engines.dsh` 下限是 `0.2.1-0`，但 devDependencies 与端到端验证只覆盖 `0.2.2-alpha.2`。低版本线依赖 `caps` 运行时探测降级，缺少"每个 0.2.1 patch 上实际能跑到哪一步"的记录。
3. **audit 未写明验证口径**：`compat/audit.md` 记了 Targeted version，但没写明"0.2.1 线靠运行时能力探测、验证基线仍是 0.2.2-alpha.2"，读者容易把范围当成逐版本验证过。
4. **界面语言只有 8 种且译文为 AI 生成**；新增语言目前需要同时改两份字典 + 一个 `locale/*.json`，没有生成器或校验清单。
5. **性能与体验的已知点**：长会话/大仓库下的边界复查要对每个 tracked 路径 `stat`；设置页历史列表无虚拟化；回填等待窗口 20 秒；已回退轮次在右侧导航里仍留"未加载"刻度（README 已知问题）。
6. **文档与事实容易漂移**：模块表、命令清单、语言数、测试数、上限值在 README / AGENTS / docs 多处手写，没有链接/事实一致性检查（`verify:host` 只验宿主行为；原先唯一的配图校验已随预览图下线一并移除）。

---

## 2. 待办

每项按「目标 → 验收标准 → 可直接执行的第一步」描述。顺序建议即编号顺序。

### 2.1 补齐 CI 工作流与发布自动化

**目标**：每个 push / PR 都跑 `npm run check`；打 tag 后能自动发布并附 provenance，同时把 [release/release.md](release/release.md) 从"手动流程"升级为与之匹配的自动化说明。

**验收标准**

- 仓库存在 `.github/workflows/ci.yml`，在 push 与 PR 上跑 `npm ci` + `npm run check`，覆盖 Node 24 与 `engines.node` 边界版本。
- 存在发布工作流：触发于 `v*` tag → 校验 tag 与 `package.json` 版本一致 → 跑全检 → 先跑 `node scripts/changelog-extract.mjs <tag>`（失败即中止）→ `npm publish --provenance` → 用抽取结果创建 GitHub Release；已发布版本跳过（幂等）。
- `release/release.md` 与 `.github/workflows/` 实况一致（不再需要"未来工作流"清单），Trusted Publisher 段落在配置完成后可用。
- 一次 `workflow_dispatch` 干跑（不发布）能跑通。
- 发布前置：`node scripts/changelog-extract.mjs v0.5.1` 先通过（需要修 CHANGELOG 的 `Full Changelog` 行）。

**第一步**：在仓库根建 `.github/workflows/ci.yml`，内容为 `actions/checkout@v4` + `actions/setup-node@v4`（`node-version: 24`）+ `npm ci` + `npm run check`；先只做 CI，不碰发布，跑通一次 PR 再继续。

### 2.2 0.2.1 线逐版本验证

**目标**：把 `>=0.2.1-0 <0.3.1-0` 这个声明变成"每个 0.2.1 patch 上都有实测结论"。

**验收标准**

- 对 0.2.1 线每个可安装的 patch 版本：`node scripts/probe-caps.mjs --json` 的输出、`npm run check` 的结果、以及手工冒烟（回退 / 预览 / 历史 / 撤销各一次）记入 `docs/compat/audit.md` 或新表格。
- 明确记录哪些面在该版本缺失、`caps` 是否正确上报、以及缺失时的降级是否符合预期。
- 若某版本无法通过核心面（`surfaceOp` / `rpc`），把 `engines.dsh` 下限上调，并同步 16 个 peer 范围与 `package-lock.json` 根元数据。

**第一步**：`npm view @deepseek-ai/dsh-session versions --json` 列出 0.2.1 线的 patch，挑最低可安装版本建一个隔离 worktree，把 devDependencies 临时钉到该版本后跑 `node scripts/probe-caps.mjs`。

### 2.3 在 compat/audit 写明验证基线

**目标**：读者能一眼分清"声明范围"与"验证范围"。

**验收标准**

- `compat/audit.md` 的 Targeted version 段落补两句：验证基线 = `0.2.2-alpha.2`；0.2.1 线的可用性由 `scripts/probe-caps.mjs` 与 `caps` RPC 在运行时判定，不是逐版本验证。
- 同时说明 `engines.dsh` 自 DSH 0.2.1-alpha.4 起是唯一准入判据、peer 范围是给旧宿主的兜底。
- 本文 §1 与 [开发指南](DEVELOPMENT-GUIDE.zh.md) §1.4 的表述与之一致。

**第一步**：打开 `docs/compat/audit.md`，在 Targeted version 引用块下补一段"验证口径"；改完运行 `npm run check` 确认现有门禁仍全绿（脚本不校验文档链接，这部分靠 2.6 的 `verify-docs`）。

### 2.4 更多界面语言

**目标**：把语言数从 8 扩到社区常用语种（候选：`ko`、`it`、`nl`、`tr`、`pl`），且新增语言不改任何接线代码。

**验收标准**

- 新增语言的 `HOST_DICTS` / `CLIENT_DICTS` 条目键集与 `en` 完全一致（类型层面即可保证）。
- `locale/<tag>.json` 通过 `tests/package-layout.test.ts` 的格式校验（两空格 JSON + 末尾换行 + `meta.title` / `meta.description`）。
- `npm run check` 全绿；设置页、确认框、命令输出在该语言下无英文残留（抽查 10 条）。
- [开发指南](DEVELOPMENT-GUIDE.zh.md) §9.1 的步骤仍然是完整的（缺步骤就补文档）。

**第一步**：复制 `src/client/locales.ts` 里 `en` 字典为模板新建一份字典，先只加 `src/locales.ts` 与 `src/client/locales.ts` 两份并登记进 `HOST_DICTS` / `CLIENT_DICTS`，跑 `npm run typecheck` 让编译器列出缺键。

### 2.5 性能与体验

**目标**：长会话、大仓库、多文件会话下，回退与设置页仍然"不卡、不误报"。

**验收标准**

- 边界复查：500 个 tracked 路径的会话里，一条用户消息的复查不阻塞消息落库（异步 + 失败不抛），并有一个基准测试或 verify-host 断言记录耗时量级。
- 设置页：历史列表在 10 条上限下无需虚拟化即可正常交互；`reload` 不重复请求（`loadSeq` 丢弃过期响应已有测试覆盖）。
- 回填：命令 20 秒窗口内成功率高；超时只写日志、不产生半回填（已有 `client-wait` 测试）。
- 右侧轮次导航的"未加载"刻度：要么在 README 的已知问题里保留，要么找到宿主侧可控的隐藏方式（找不到就明确写"不改"）。

**第一步**：用 `tests/helpers.ts` 造一个 500 路径、200 条消息的合成会话，在 `tests/snapshot-bytes.test.ts` 或新套件里给 `reconcileTracked` 计时，把当前数值记进本文件（作为后续对比基线）。

### 2.6 文档同步机制

**目标**：把"多处手写、容易漂移"的清单变成可校验的。

**验收标准**

- 新增 `scripts/verify-docs.mjs`（当前不存在）：校验两份中文文档与 docs/README 里所有**相对链接**存在；校验文档中出现的版本号、`8 MiB`、`100`、`10`、`42`、`8 种语言` 与 `package.json` / 源码常量 / `tests/` 实况一致。
- `npm run check` 或独立的 `npm run verify:docs` 跑它；CI（2.1）里也要跑。
- [开发指南](DEVELOPMENT-GUIDE.zh.md)、[docs/README](README.md)、[AGENTS](../AGENTS.md) 三处的模块清单不再互相矛盾（至少被脚本覆盖的部分）。

**第一步**：写 `scripts/verify-docs.mjs` 的第一条检查——遍历 `docs/**/*.md` 抽取 `](...)` 中的相对路径，`fs.access` 校验存在，非零退出即失败；先在本地跑一遍拿到当前断链清单。

---

## 3. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DSH 版本线演进快 | `engines.dsh` 宽界可能掩盖行为差异 | 每次升线跑 `probe-caps` + `verify-host`；把结论写进 audit |
| 无 CI 时"本地绿"不可复现 | 发布质量取决于个人环境 | 2.1 优先落地；发布前手工贴 `npm run check` 输出 |
| 0.2.1 线降级不完整 | 用户装上后功能缺失但无提示 | `caps` 已在设置页上报；2.2 补实测表 |
| 存储增长 | 长会话/大文件占磁盘 | 8 MiB 单文件上限、100 组窗口、默认关闭的按龄清扫 |
| 多进程并发 | 两个宿主进程同时改同一工作区 | 已知边界：进程内互斥；跨进程锁列为候选（见 §4） |
| Windows 文件占用 | 卸载/清理时 `ENOTEMPTY`、文件被占 | `HistoryStore.dispose()` 已等待在途写；verify-host 对临时树拆除做重试 |
| 文档漂移 | 接手者按错信息改代码 | 2.6 的校验脚本 + "事实以源码为准"的写作约定 |

---

## 4. 不做的事

以下项在当前产品定位下**明确不做**；若要改变，先改定位与 [README](../README.md) 的"明确不做的事"。

- **不恢复对话**：撤销只还原文件；被撤回的对话节点已移出 surface，不会"复活"。
- **不做整树 / Git 级快照**：不接管 git，也不备份整个工作区。
- **不追踪子代理会话**，也不在子代理内提供回退面。
- **不做 fork / 分支回退**：宿主已有"在新对话中分支"。
- **不做跨进程锁**（当前候选，不是本轮计划）：进程内互斥已够覆盖单进程场景；加锁需要新的存储与失效策略。
- **不引入第三方运行时依赖**：`@deepseek-ai/*` 保持 external，tarball 不携带宿主包。
- **不自建 UI 框架**：候选用宿主 `popupSelect`，设置面用宿主表单原语，确认框保持纯 DOM 小实现。
- **不改会话日志**：append-only 是硬约束，任何"清理旧标记"的想法都越界。
