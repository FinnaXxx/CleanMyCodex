# CleanMyCodex

CleanMyCodex 用于扫描和清理 Codex 产生的缓存、会话数据、插件旧版本和工作产出，支持 macOS、Windows 和 Linux。

## 扫描设计

扫描由 Electron 主进程统一调度，耗时的文件遍历放在 worker 中执行，避免阻塞界面。扫描结果分为四部分：

- Codex 数据目录：识别缓存、日志、临时文件和 SQLite 可回收空间。
- 会话：流式读取 rollout，统计会话信息、关联资产和内嵌图片，避免一次加载大文件。
- 插件：结合磁盘目录和 `codex app-server` 返回的信息，区分当前版本、旧版本和卸载残留。
- 工作产出：仅在用户打开对应页面后扫描，优先关联 SQLite 中的来源会话标题，并标记 git 未提交或未推送状态。

扫描结果只是只读快照。执行清理时，主进程会根据快照重新生成任务并校验路径；配置、凭据、状态库、当前插件和工作产出不会进入自动清理范围。

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
