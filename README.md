# Clean My Codex

Clean My Codex 用于扫描和清理 Codex 产生的缓存、会话数据、插件旧版本和工作产出。第一版 Release 提供 macOS Apple Silicon（arm64）和 Intel（x64）两个安装包。

## 扫描设计

扫描由 Electron 主进程统一调度，耗时的文件遍历放在 worker 中执行，避免阻塞界面。扫描结果分为四部分：

- Codex 数据目录：识别缓存、日志、临时文件和 SQLite 可回收空间。
- 会话：流式读取 rollout，统计会话信息并关联生成资产，避免一次加载大文件。
- 插件：结合磁盘目录和 `codex app-server` 返回的信息，区分当前版本、旧版本和卸载残留。
- 工作产出：仅在用户打开对应页面后扫描，优先关联 SQLite 中的来源会话标题，并标记 git 未提交或未推送状态。

扫描结果只是只读快照。执行清理时，主进程会根据快照重新生成任务并校验路径；配置、凭据、状态库、当前插件和工作产出不会进入定时清理范围。

### 数据来源

Clean My Codex 不通过一个接口读取所有信息，而是按数据的实际来源扫描：

- `codex app-server`：目前只调用 `initialize` 和 `plugin/list`，用于确认已安装的插件及版本。会话扫描和删除不依赖它。
- rollout JSONL：直接流式扫描 `~/.codex/sessions` 和 `~/.codex/archived_sessions`。它们是会话事件的持久记录；Codex 也以 rollout 为来源构建会话历史投影。
- `state_*.sqlite`：只读获取标题、工作目录、归档状态及子代理父子关系；删除会话时才定向删除该会话及所有后代的状态行。
- `session_index.jsonl`：作为生成标题的补充索引。它很小，清理时不为回收少量空间而重写。
- `thread_history_*.sqlite`：Codex 从 rollout 派生出的会话历史投影。扫描器把它作为“会话投影数据库”统计；删除会话时会直接清理相应行，不等待 Codex 重建。
- `generated_images/<thread-id>`：会话生成的独立图片目录。
- `visualizations/YYYY/MM/DD/<thread-id>`：Codex 生成的富视觉结果，例如 JPG/PNG 对比图或 HTML 可视化预览。扫描时会递归识别日期层级并归到对应会话。

### 会话、分段与子代理

同一个会话可能分散在多个 rollout 文件中，也可能递归生成多层子代理。界面只显示一个顶层会话，但统计与操作使用完整会话闭包：主会话的所有续写分段、所有层级子代理的分段，以及各自关联的生成图片和 Visualization 目录。

第一版不扫描、统计、去重或改写会话内嵌图片，也不提供单独删除生成图片的入口。会话数据只支持整段删除，避免出现 rollout、派生 SQLite 和界面缓存之间状态不一致。

### 删除会话实际执行的操作

删除一个会话需要 ChatGPT/Codex 已退出，随后依次执行：

1. 将主会话的全部 rollout 分段移到系统废纸篓。
2. 将所有层级子代理的全部 rollout 分段移到系统废纸篓。
3. 将主会话和子代理关联的 `generated_images`、Visualization 目录移到系统废纸篓。
4. 在最新的 `thread_history_*.sqlite` 中删除主会话及所有后代的 `thread_items`、`thread_turns` 和 `thread_history_projection_state` 行。
5. 在最新的 `state_*.sqlite` 中删除相同会话集合的 `threads`、`thread_dynamic_tools` 和 `thread_spawn_edges` 行，并执行 `VACUUM`/WAL checkpoint 归还数据库空间。

系统废纸篓中的占用不再计作 Clean My Codex 的已占用空间；如果需要立即归还整个磁盘的可用空间，由用户清空系统废纸篓。

配置、凭据、当前插件、工作产出，以及 `session_index.jsonl` 等小型辅助元数据不会随会话删除。

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
