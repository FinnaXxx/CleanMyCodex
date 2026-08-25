<div align="center">

<img src="docs/images/banner.png" alt="Clean My Codex — Scan. Understand. Reclaim." />

**看看你的 Codex 占用了多少空间**

[English](README.md) · 简体中文

[![Release](https://img.shields.io/github/v/release/FinnaXxx/CleanMyCodex)](https://github.com/FinnaXxx/CleanMyCodex/releases)
[![CI](https://github.com/FinnaXxx/CleanMyCodex/actions/workflows/ci.yml/badge.svg)](https://github.com/FinnaXxx/CleanMyCodex/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-zh-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/overview-zh-light.png">
  <img src="docs/images/overview-zh-light.png" width="900" alt="Clean My Codex 总览界面：当前占用与本次可释放、空间分布，以及扫描出的缓存、日志与数据库" />
</picture>

</div>

## 注意事项

> [!IMPORTANT]
> **当前是测试阶段，请提前备份。** 清理是永久删除，且不能保证在所有 Codex 版本、所有电脑上都能正常工作。第一次清理前请先备份。

清理前请退出 ChatGPT/Codex，并对 Codex 数据目录（通常是 `~/.codex`）和 `~/Library/Application Support/Codex` 做一份可恢复的副本。重新打开 Codex 确认清理结果无误前请保留备份；当前的 Time Machine 备份也可以。

欢迎提 PR 共建，开始修改前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这是什么

Codex 会不断堆积：每一次会话留下的 rollout 文件、一直没被删掉的插件旧版本、更新中断留下的 staging 目录，以及会话写到磁盘上的各种产出。Clean My Codex 一次扫描把这些都统计出来，并按类别列出每一项占了多少空间。

- **分六块扫描。** Codex 数据目录、会话、会话资产、插件、worktree、工作区，每块一个页面、一套规则。
- **数字如实。** SQLite 数据库只统计实际占用，可复用的空闲页不会被算成可释放空间。
- **默认保守。** 没有正面证据表明可以删的东西一律不推荐，所以扫描结果里推荐项为 0 是正常结果，不是扫描失败。只统计、不删除的内容在界面上都会标出来。
- **会话按整体处理。** 跨多个 rollout 分段、带多层子代理的会话在列表里是一行，删除也是一次，连带派生数据库和桌面端自己的那份副本一起清理。
- **worktree 交给 git 收。** 需要的时候 Codex 会在 `~/.codex/worktrees` 下给会话检出一份仓库，装完依赖动辄几百 MB。这里逐个列出仓库状态、其中多少是构建产物、关联了多少会话。删除走 `git worktree remove`，这样原仓库不会留下一个指向已不存在目录的 worktree 记录。
- **定时清理。** 按周期运行，范围只有过期临时目录、已确认的插件旧版本和超过保留期的会话；跳过置顶会话、未完成的 goal 和排队中的任务，不碰缓存、配置、独立会话资产、worktree 和工作区。

### 不会被删除的东西

worktree 只有在 git 为它保留的管理目录里仍带着 Codex 写入的标记文件时，才会被列为可删。你自己建的 worktree —— 哪怕就放在同一个目录下 —— 只统计、只展示，永远不提供删除。原仓库已经被删掉或移走的也一样：标记文件跟着仓库一起没了，就再没有东西能证明这份检出是谁创建的。

配置与凭据 —— `config.toml`、`auth.json`、`secrets/` 下 age 加密的密钥库、MCP OAuth 回退文件 `.credentials.json` 与 `.env` —— 以及 Codex 全部六个运行期 SQLite 数据库和它在 `db-backups/` 里保留的崩溃恢复副本、`proxy/` 下的托管代理 CA、Windows 沙箱身份文件、插件持久化在 `plugins/data` 的数据、Codex 当前正在使用的插件版本及其运行组件、承载桌面端登录的 Chromium 用户资料数据、桌面应用自己的日志，以及全部缓存 —— 既包括 Codex 自己的运行元数据缓存，也包括桌面应用的运行缓存。工作区另外不进入定时清理。这些都会被统计以保证总量对得上，并在界面上标记为受保护。

## 安装

从 [Releases](https://github.com/FinnaXxx/CleanMyCodex/releases) 下载最新安装包。macOS 提供 Apple Silicon（`arm64`）和 Intel（`x64`）两个 `.dmg`；Windows 提供 x64 NSIS 安装程序（`.exe`）。

macOS 安装包做了 ad-hoc 签名但未做公证，首次打开需要在 **系统设置 → 隐私与安全性 → 仍要打开** 里放行一次。Windows 安装程序目前未签名，Microsoft Defender SmartScreen 可能会要求确认后才能运行。

## 兼容性

| 平台 | 分发方式 | 验证情况 | 状态 |
| --- | --- | --- | --- |
| macOS，Apple Silicon | `.dmg` 正式包 | CI 与打包验证 | 支持 |
| macOS，Intel | `.dmg` 正式包 | CI 与打包验证 | 支持 |
| Windows，x64 | `.exe` NSIS 正式包 | CI 与打包验证 | 实验性支持；可用定时清理 |

Clean My Codex 跟随当前 Codex Desktop 的存储布局，建议同时使用最新版 Clean My Codex 与 Codex。桌面端部分存储格式并未公开且可能变化，因此测试阶段不承诺固定的 Codex 版本兼容范围。

## 隐私与网络访问

扫描和清理均在本机执行。Clean My Codex 不包含分析或遥测，也不会上传凭据、会话内容或文件元数据。打包后的应用会在启动时请求一次 GitHub Releases 元数据以检查新版本，下载和升级仍需手动完成；对 `codex app-server` 的调用使用本机 Codex 进程。

## 扫描设计

扫描由 Electron 主进程统一调度，耗时的文件遍历放在 worker 中执行，避免阻塞界面。扫描结果分为六部分：

- **Codex 数据目录**：识别缓存、日志和临时文件；SQLite 数据库仅统计实际占用，不把可复用空闲页列为清理项。
- **会话**：流式读取 rollout，统计会话信息并关联会话资产，避免一次加载大文件。
- **会话资产**：扫描 ImageGen、Visualization 与 Plan，记录文件数、占用、修改时间和来源会话；同一会话的 Visualization 源目录与 Viewer 合并为一项；Plan 以其最新修订的标题命名。
- **插件**：结合磁盘目录和 `codex app-server` 返回的信息，区分当前版本、旧版本和卸载残留。
- **Worktree**：Codex 在 `~/.codex/worktrees` 下为需要仓库的会话检出的副本，逐个列出仓库状态、构建产物占比与关联会话。
- **工作区**：仅在用户打开对应页面后扫描，优先关联 SQLite 中的来源会话标题，并标记 git 未提交或未推送状态。

扫描结果只是只读快照。执行清理时，主进程会根据快照重新生成任务并校验路径；缓存、配置、凭据、状态库、当前插件、worktree 和工作区不会进入定时清理范围。

### 工作产出与生成资产的设计思路

六个类别里有三个是会话在磁盘上留下的产出，它们和会话的归属关系不同，删除处理也不同。

| 类别 | 实际位置 | 与会话的归属 | 关联如何建立 | 删除方式 |
| --- | --- | --- | --- | --- |
| **会话资产** | `~/.codex/generated_images`、`visualizations`、`visualization-viewers`、`plans` | 1 个会话 ↔ 1 个目录 | 目录名就是 thread ID | `rm -rf` |
| **工作区** | `~/Documents/Codex` | N 个会话 ↔ 1 个目录 | `sourceThreads[]`，从 SQLite 中的工作目录反查 | `rm -rf` + git 安全检查 |
| **Worktree** | `~/.codex/worktrees` 下的检出 | N 个会话 ↔ 1 个 worktree | 同样靠 `sourceThreads[]` 反查 | `git worktree remove` |

- **会话资产随会话删除，工作区不随会话删除。** `generated_images/<thread-id>` 是某个会话的专属目录，会话没了它必然是垃圾，连父带子一起删是安全的——父都不要了，子也没有保留的意义。`~/Documents/Codex/xxx` 则可能被多个会话共享（`sourceThreads` 是数组），又位于用户的文档目录、是真实工作成果，所以不随会话删除。区分原则一句话：会话资产是随会话删除的，工作区是不随会话删除的。
- **可以正向连带，不能反向连带。** 删除 worktree 或工作区时可以勾选“同时删除关联会话”——父删子，把工作产出对应的会话一并删掉。但会话资产不能反向删除其所属会话——子删父不合适：资产只是会话的产物，不该替会话决定去留。
- **产出由本工具删除，不走 `thread/delete`。** 这三类目录都不在 `thread/delete` 协议管辖内，由本工具自己删除；协议只负责会话本身的 rollout、数据库记录和索引行。

### 数据来源

下面涉及 `~/.codex` 的每一条路径，都对照 [Codex 源码](https://github.com/openai/codex) 核对过 —— 桌面应用正是基于这套 harness 开发的 —— 而不是从某一台机器的目录列表反推。桌面端自己的存储没有开源：App Support 目录树、Chromium 用户资料、`~/.codex/sqlite` 和 `.codex-global-state.json` 只能依据实际观测，因此处理得更保守，只统计，文件本身从不删除。

按数据的实际来源扫描：

- **`codex app-server`**：调用 `plugin/list` 确认已安装的插件及版本；支持 `thread/delete` 的版本会优先由 Codex 自己删除会话，不支持时回退到本地定向清理。
- **rollout JSONL**：直接流式扫描 `~/.codex/sessions` 和 `~/.codex/archived_sessions`。它们是会话事件的持久记录；Codex 也以 rollout 为来源构建会话历史投影。
- **`state_*.sqlite`**：只读获取标题、工作目录、归档状态及子代理父子关系。标题优先取 Codex 生成的简洁 `name`，其次 `title`、再次 `preview`，后两者通常存的是完整的首条用户消息；父子关系来自 `thread_spawn_edges`。删除会话时才定向删除该会话及所有后代的状态行。
- **`session_index.jsonl`**：作为生成标题和桌面会话列表的补充索引；删除会话时会定向移除相同会话集合的索引行。
- **`thread_history_*.sqlite`**：Codex 从 rollout 派生出的会话历史投影。扫描器把它作为“会话投影数据库”统计；删除会话时会直接清理相应行，不等待 Codex 重建。
- **`~/.codex/sqlite/*.db`**：ChatGPT/Codex 桌面端自己的存储，`local_thread_catalog` 是左侧边栏的会话列表，同目录还有会话摘要和历史快照。只在删除会话时按 thread ID 定向删行，从不删文件。
- **`.codex-global-state.json`**：桌面端的持久化状态，按 thread ID 存置顶、项目归属、排队任务等。只剔除被删会话的键和列表项；`electron-persisted-atom-state`（草稿、面板布局等界面状态）整块保持不动。
- **`generated_images/<thread-id>`**：会话生成的独立图片目录，在「会话资产」页单独列出。
- **`visualizations/YYYY/MM/DD/<thread-id>`**：Codex 生成的富视觉结果，例如 JPG/PNG 对比图或 HTML 可视化预览。扫描时会递归识别日期层级，在「会话资产」页列出并关联来源会话。
- **`plans/<thread-id>`**：Codex plan 模式产出的计划文档，按会话归集。每个会话目录下可能有多份修订，扫描时聚合成一项，并用最新修订的 H1 标题命名；随所属会话一起删除。
- **`visualization-viewers/<thread-id>`**：Codex 从上述片段渲染出的查看器，其源码自己称之为 viewer cache。扫描时与同一 thread 的 Visualization 源目录合并展示和删除，避免留下无法完整使用的半套结果。
- **`~/.codex/cache`**：远程插件目录（`remote_plugin_catalog`）、Apps server 与工具定义（`codex_apps_server_info`、`codex_apps_tools`）、connector 目录（`codex_app_directory`）和终端宠物素材（`tui-pets`）。它们都可重建，但后续版本可能在旁边放置实时状态，因此整个目录作为受保护数据统计，不提供删除。
- **`~/Library/Logs/com.openai.codex/YYYY/MM/DD`**：桌面应用自己的日志，每个会话每个进程一个文件。应用自己会轮转，只保留最近几天，所以这里只统计、不清理——清它省下的正是它自己马上就要省的，还会连带删掉它自己诊断要读的那几天。整棵日志树都禁止删除。
- **`~/Library/Caches/Codex`、`~/Library/Caches/com.openai.codex`**：桌面应用运行缓存，容器及其所有叶子目录都作为受保护数据统计，不提供删除。
- **承载桌面端登录的 Chromium 用户资料数据**：`Cookies`、`Network/`、`Local Storage`、`Session Storage`、`IndexedDB`、`Service Worker`、`Preferences`、`Web Data`、`Local State`、`Partitions/`、`codex-browser-app/` 等。根目录、`Default/` 和桌面端专用分区布局都锁定，只统计不清理；整个 App Support 和平台应用缓存容器都禁止删除。
- **`~/.codex/sqlite`、`.codex-global-state.json` 及其 `.bak`**：桌面端自己的会话库和持久状态，只在删除会话时按 thread ID 删行或删键，文件本身锁定。
- **用户自有内容与实时状态路径**：`rules`、`skills`、`hooks` 与 `hooks.json`、`memories`、`agents`、`themes`、`avatars`、`prompts`、`shell_snapshots`、`attachments`、`session_index.jsonl`、`installation_id`、`managed_config.toml`、`environments.toml`、app-server 守护进程与控制套接字、Wasm TTS 组件及 goals/queue/memories/logs 数据库 —— 纳入占用统计但保持锁定。
- **`~/.codex/.tmp`**：名字虽然像临时目录，实际是实时状态 —— curated 插件 checkout、已安装的插件市场、内置的 `openai-bundled` 源以及 Codex 的 rollout 锁都放在这里。只有 Codex 自己创建的临时目录前缀才可清理，即 `plugins-clone-*` checkout，以及 Codex 启动时自清扫只删 clone、因而遗留下来的 `plugins-backup-*` 目录。其他未知 `.tmp` 子目录不会因为存放时间长就自动推断为可删。
- **`~/.codex/tmp/arg0`**：和 `.tmp` 是两个不同的目录，为 `apply_patch` 和沙箱辅助程序的 shim 存放每个运行中 Codex 进程各自一个带锁目录。Codex 每次启动都会删掉所有能拿到锁的同级目录，因此还留着的按它自己的判定就是废弃的，删除的代价只是下次启动重建一次符号链接。
- **各 staging 父目录**：`.tmp/marketplaces/.staging`、`plugins/.remote-plugin-install-staging` 和 `plugins/.marketplace-plugin-source-staging`。Codex 会把完成的目录树从这里 rename 出去、其余丢弃，所以残留的每个子项都属于某个中途死掉的安装进程。

首页「建议清理」只包含两类有额外证据的内容：超过 24 小时未写入、位于 Codex 自己视为暂存区的目录、且不属于当前源的安装／更新 staging 残留；以及 `plugin/list` 权威确认已有当前版本的旧插件目录。名为 `local` 的插件目录永远不算在内，无论目录服务怎么报 —— Codex 仅凭目录列表决定生效版本，而 `local` 压过任何带版本号的同级目录。没有这两类内容时，推荐项为 0 是正常结果。

### 会话、分段与子代理

同一个会话可能分散在多个 rollout 文件中，也可能递归生成多层子代理。界面只显示一个顶层会话，但统计与操作使用完整会话闭包：主会话的所有续写分段、所有层级子代理的分段，以及各自关联的生成图片和 Visualization 目录。

当前版本不扫描、统计、去重或改写会话内容中内嵌的图片；只管理 Codex 落盘的 ImageGen、Visualization 与 Plan 资产目录，其中 Viewer 作为 Visualization 的配套目录处理。会话资产可以在独立页面删除，删除会话时仍会联动清理该会话及其子代理的全部关联资产。

### 删除会话实际执行的操作

删除一个会话需要 ChatGPT/Codex 已退出，随后依次执行：

1. 先解析这次删除涉及的全部 thread ID：rollout 文件名里的 ID、`thread_spawn_edges` 里的子代理，以及 `state_*.sqlite` 中 rollout 路径指向这些文件的记录。桌面会话有自己的 thread ID，且不出现在文件名里，只能靠 rollout 路径反查。
2. 优先对主会话、桌面会话记录及每个层级子代理分别调用 Codex app-server 的 `thread/delete`；每个请求会永久删除该 thread 的全部续写 rollout、数据库记录和 `session_index.jsonl` 行。
3. 旧版本不支持协议或任一请求失败时，回退到本地兼容清理，并永久删除协议未处理的 rollout。
4. 永久删除协议不管理的 `generated_images`、Visualization 目录。
5. 无论走协议还是回退，最后都用同一组 thread ID 复查一次 `thread_history_*.sqlite`、`state_*.sqlite` 和 `session_index.jsonl`，删除仍指向已删除 rollout 的记录。
6. 最后清理桌面端自己的那份副本：`~/.codex/sqlite/*.db`（`local_thread_catalog` 就是左侧边栏的会话列表，同目录还有摘要库和历史快照库）按 thread ID 删行；`~/.codex/.codex-global-state.json` 及其 `.bak` 剔除对应的映射键、列表项和 `…threadId` 字段。`thread/delete` 不管这两处 —— 协议报成功、内核数据也确实清干净了，会话照样留在侧边栏，点开报 `no rollout found for thread id`，就是这里没删。

每一步删掉多少行都会记进清理日志。

配置、凭据、当前插件和工作区不会随会话删除；与目标会话直接关联的 `session_index.jsonl` 行会一并删除。

自动会话清理会跳过置顶会话、存在未完成 goal 的会话和仍有 queued item 的会话；任一子代理满足这些条件时，整个顶层会话都会跳过。置顶同时取自 `state_*.sqlite` 的 `is_pinned` 列和 `.codex-global-state.json` 的 `pinned-thread-ids` —— 桌面端把置顶记在后者，只看列会漏。手动删除不受这些条件限制：明确选中并确认过的会话就按用户的意思删；会话列表会给置顶会话标出「置顶」，确认弹窗也会说明所选会话里有几个是置顶的。手动删除前会先检查 SQLite 完整性、受支持的核心表和写锁，避免会话文件已经删除后才发现数据库无法修改。插件删除则会在真正执行前重新向 `codex app-server` 查询当前版本，防止扫描后升级造成误删。

### 日志

另外有一件本工具不管、但值得知道的事：Codex 会把每一轮对话的检查点作为 git ref 写进你自己的仓库，路径在 `refs/codex/turn-diffs/` 下。这些 ref 会让它们指向的对象一直存活，`git gc` 回收不掉，跑得久的仓库 `.git` 会持续变大。它们在你的仓库里而不在 Codex 数据目录里，所以 Clean My Codex 既不统计也不触碰。

清理会写入清理日志（缓存和残留清理逐条记录删掉的路径与字节数，删除失败或跳过的也记）：macOS `~/Library/Logs/CleanMyCodex/cleanup.log`，Windows `%APPDATA%\CleanMyCodex\logs\cleanup.log`。每次删除记录解析出的 thread ID、`thread/delete` 是否可用、本地复查删掉了多少行，以及桌面端的哪张表、哪个状态文件被清理了多少条，超过 1 MB 保留一代历史。定时清理另有 `autoclean.log`。设置页的「诊断 → 日志」可以直接打开这个目录。

## 开发

需要 Node.js 22 和 pnpm 11.19。

```bash
pnpm install
pnpm dev
```

完整检查：

```bash
pnpm check
```

打包：

```bash
pnpm build:mac
pnpm build:win
```

## 贡献与支持

开发流程和清理安全要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。Bug 与功能建议请提交到 [GitHub Issues](https://github.com/FinnaXxx/CleanMyCodex/issues)，分享日志前请阅读 [SUPPORT.md](SUPPORT.md)。

安全漏洞不要提交到公开 Issue，请按照 [SECURITY.md](SECURITY.md) 私下报告。参与项目时请遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 许可

[MIT](LICENSE)

Clean My Codex 是独立的社区项目，与 OpenAI 无隶属、背书或赞助关系。Codex 与 OpenAI 是 OpenAI 的商标。
