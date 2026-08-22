# Clean My Codex

Clean My Codex 用于扫描和清理 Codex 产生的缓存、会话数据、插件旧版本和工作产出。第一版 Release 提供 macOS Apple Silicon（arm64）和 Intel（x64）两个安装包。

## 扫描设计

扫描由 Electron 主进程统一调度，耗时的文件遍历放在 worker 中执行，避免阻塞界面。扫描结果分为四部分：

- Codex 数据目录：识别缓存、日志和临时文件；SQLite 数据库仅统计实际占用，不把可复用空闲页列为清理项。
- 会话：流式读取 rollout，统计会话信息并关联生成资产，避免一次加载大文件。
- 插件：结合磁盘目录和 `codex app-server` 返回的信息，区分当前版本、旧版本和卸载残留。
- 工作产出：仅在用户打开对应页面后扫描，优先关联 SQLite 中的来源会话标题，并标记 git 未提交或未推送状态。单次扫描最多检查 32 个 git 仓库，超出的标记为“未检查”，同样按不安全处理。

扫描结果只是只读快照。执行清理时，主进程会根据快照重新生成任务并校验路径；配置、凭据、状态库、当前插件和工作产出不会进入定时清理范围。

### 界面文案与多语言

主进程不生成任何展示文案。扫描器、清理引擎、planner 和平台服务只产出 `shared/messages.ts` 里的 `Message`（一个 key 加参数），由渲染层按用户选择的语言渲染。分类标题、条目说明、跳过原因、扫描阶段、运行中提示和错误都走这一张表，两种语言写在同一行，缺一边是类型错误。

错误是唯一的例外：它以 `Error.message` 字符串穿过 IPC，所以 `encodeMessage` 会在文本里嵌一个可解析的标记，渲染层用 `decodeMessage` 还原；不是本表产生的文本（Node errno、SQLite、git）原样显示。

定时清理没有窗口，读不到渲染层的语言设置，因此渲染层会把当前语言写入 `userData/language.json`，后台运行的日志和完成通知据此渲染。

### 数据来源

Clean My Codex 不通过一个接口读取所有信息，而是按数据的实际来源扫描：

- `codex app-server`：目前只调用 `initialize` 和 `plugin/list`，用于确认已安装的插件及版本。会话扫描和删除不依赖它。
- rollout JSONL：直接流式扫描 `~/.codex/sessions` 和 `~/.codex/archived_sessions`。它们是会话事件的持久记录；Codex 也以 rollout 为来源构建会话历史投影。
- `state_*.sqlite`：只读获取标题、工作目录、归档状态及子代理父子关系；删除会话时才定向删除该会话及所有后代的状态行。
- `session_index.jsonl`：作为生成标题的补充索引。它很小，清理时不为回收少量空间而重写。
- `thread_history_*.sqlite`：Codex 从 rollout 派生出的会话历史投影。扫描器把它作为“会话投影数据库”统计；删除会话时会直接清理相应行，不等待 Codex 重建。
- `generated_images/<thread-id>`：会话生成的独立图片目录。
- `visualizations/YYYY/MM/DD/<thread-id>`：Codex 生成的富视觉结果，例如 JPG/PNG 对比图或 HTML 可视化预览。扫描时会递归识别日期层级并归到对应会话。
- `~/.codex/cache`、App Support 顶层 `Cache`/`GraphiteDawnCache`：作为可重建缓存统计，要求 ChatGPT/Codex 退出后才能清理。
- `vendor_imports`、`shell_snapshots`、`attachments`、`ambient-suggestions`、`browser`、Wasm TTS 组件及 goals/queue/memories 数据库：纳入占用统计但保持锁定。
- `.tmp/bundled-marketplaces`：只保护当前 `openai-bundled` 源；超过一小时未更新的同级 `.staging-*` 目录作为更新残留列出。

### 会话、分段与子代理

同一个会话可能分散在多个 rollout 文件中，也可能递归生成多层子代理。界面只显示一个顶层会话，但统计与操作使用完整会话闭包：主会话的所有续写分段、所有层级子代理的分段，以及各自关联的生成图片和 Visualization 目录。

第一版不扫描、统计、去重或改写会话内嵌图片，也不提供单独删除生成图片的入口。会话数据只支持整段删除，避免出现 rollout、派生 SQLite 和界面缓存之间状态不一致。

### 删除会话实际执行的操作

删除一个会话需要 ChatGPT/Codex 已退出，随后依次执行：

1. 将主会话的全部 rollout 分段移到系统废纸篓。
2. 将所有层级子代理的全部 rollout 分段移到系统废纸篓。
3. 将主会话和子代理关联的 `generated_images`、Visualization 目录移到系统废纸篓。
4. 从主会话、续写分段及子代理 rollout 文件名收集全部关联 ID，并在最新的 `thread_history_*.sqlite` 中删除这些 ID 的 `thread_items`、`thread_turns` 和 `thread_history_projection_state` 行；续写分段不依赖 `thread_spawn_edges`。
5. 在最新的 `state_*.sqlite` 中删除相同会话集合的 `threads`、`thread_dynamic_tools` 和 `thread_spawn_edges` 行，并执行 WAL checkpoint 让删除落盘；不主动 `VACUUM` SQLite 可复用空闲页。

系统废纸篓中的占用不再计作 Clean My Codex 的已占用空间；如果需要立即归还整个磁盘的可用空间，由用户清空系统废纸篓。

配置、凭据、当前插件、工作产出，以及 `session_index.jsonl` 等小型辅助元数据不会随会话删除。

自动会话清理会跳过置顶会话、存在未完成 goal 的会话和仍有 queued item 的会话；任一子代理满足这些条件时，整个顶层会话都会跳过。手动删除前会先检查 SQLite 完整性、受支持的核心表和写锁，避免会话文件已经移入废纸篓后才发现数据库无法修改。插件删除则会在真正执行前重新向 `codex app-server` 查询当前版本，防止扫描后升级造成误删。

压缩后的 `.jsonl.zst` 归档 rollout 不解压，因此读不到 `cwd`、首句预览、工具标记和子代理关系：它们只按文件名归属会话，并作为顶层条目单独列出，不会折叠到父会话下。

### 目录解析

所有平台相关路径都挂在三个可注入的根上——`home`（`~/.codex` 或 `CODEX_HOME`）、`library`（macOS `~/Library`、Windows `%APPDATA%`、Linux `$XDG_CONFIG_HOME`）和 `caches`（macOS `~/Library/Caches`、Windows `%LOCALAPPDATA%`、Linux `$XDG_CACHE_HOME`）。清理引擎可以整体删除 `caches` 下的应用缓存目录，所以这三个根必须能被测试注入到临时目录，否则跑一次测试就会动到用户真实的缓存。

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
pnpm build:linux
```
