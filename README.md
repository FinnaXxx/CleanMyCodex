# CleanMyCodex

macOS 上的 Codex 空间扫描与清理工具。

Codex 的数据分散在 `~/.codex`、`~/Library/Application Support/Codex`、`~/Library/Caches` 和
`~/Library/Logs` 里，大部分会被 macOS 归到「系统数据」，在访达里看不出来。CleanMyCodex 把这些
位置整理成一张清单，标出哪些可以安全回收、哪些需要确认、哪些永远不动。

## 界面

只有一个主界面：空间扫描。会话、插件版本和自动清理都是它的下级详情，从对应的卡片打开，
不再是并列的标签页——同一次扫描结果不会被拆到几个地方去看。

## 功能

### 空间扫描

- 扫描临时目录、插件市场缓存、浏览器与渲染缓存、应用缓存、旧应用日志、生成图片和 Computer Use 组件。
- 日志数据库单独处理：读取 `page_size`、`page_count`、`freelist_count`，只把**空闲页**算作可回收空间。
- 分成「建议清理 / 谨慎清理 / 受保护」三组，点整行即可展开看到具体路径和大小。
- 生成图片按线程分组，直接显示是哪个会话产生的；会话已删除的图片会单独标出，可以安全清理。
- 扫描过程显示当前路径与进度，可以随时停止。

### 会话记录

- 未归档与已归档会话统一列出：归档只是隐藏，不释放空间。
- 每个会话显示会话文件大小、内嵌图片占用和图片数量，并标记 Browser / Computer Use / ImageGen / 图片密集会话。
- 每行显示会话标题（没有标题时回落到第一句用户消息）和所属项目，而不是只有一串 UUID。
- 支持按占用、内嵌图片、最后活动或名称排序，可搜索标题/项目，并按「最后活动早于 N 天」批量选择。
- 过滤与排序结果有缓存，只在条件变化时重算，长列表滚动不会卡。
- 删除优先调用 app server 的 `thread/delete`，同时清理 rollout、关联元数据和派生子线程；
  没有 `codex` 命令行时退回到「移到废纸篓」，并同时处理 `generated_images` / `visualizations` 里的关联资产。
- 不会改写 JSONL 里的图片字段，避免破坏会话恢复和线程引用。

### 插件版本

- 递归查找带 `.codex-plugin/plugin.json` 的版本目录，包括各自的 Python `.venv`。
- 通过 app server 的 `plugin/list` 确认当前版本；确认不了就全部标记为「未确认」并禁止清理。
- 只清理旧版本和卸载残留，当前版本和 `.plugin-appserver` 永远受保护。

### 自动清理

- 写入用户级 LaunchAgent（`com.finnaxxx.clean-my-codex.autoclean`），按设定周期运行 `CleanMyCodex --auto-clean`。
- Codex 正在运行时整体跳过，等待下一次计划任务。
- 可分别设置归档与未归档会话的保留天数，默认关闭；缓存与旧版本插件默认开启。
- 可选登录时启动（SMAppService）与完成后通知，运行记录写入 `~/Library/Logs/CleanMyCodex/autoclean.log`。

## 安全规则

- 普通文件一律**移到废纸篓**，不做不可恢复的删除。
- 日志数据库只做 `wal_checkpoint(TRUNCATE)` → `VACUUM` → `integrity_check`，不删除诊断记录；
  Codex 运行时自动跳过。
- 以下内容永不清理：`auth.json`、`config.toml`、`state_*.sqlite`（含 WAL/SHM）、`rules`、`hooks`、
  用户 skills 与 memories、当前启用的插件版本、`~/Documents/Codex`，以及
  `Application Support/Codex/Default` 中的 Cookies、Local Storage、登录信息。
- 每一次删除都会经过路径白名单校验：目标必须位于 Codex 的数据目录内，且不是数据目录本身。

## 构建

```bash
./scripts/build-app.sh debug
open "dist/CleanMyCodex.app"
```

Universal Release 同时支持 Apple 芯片和 Intel 芯片，要求 macOS 14 或更高版本：

```bash
./scripts/build-app.sh release
```

## 构建 DMG

```bash
./scripts/package-release.sh
```

- `dist/CleanMyCodex-0.1.0-universal.dmg`

## 测试

```bash
swift test
```

默认扫描 `~/.codex`。可通过 `CODEX_HOME` 指定其他目录，`CODEX_BINARY` 指定 `codex` 命令行位置。
设置 `CODEX_CLEANER_REAL_SCAN=1` 时，测试会额外扫描真实的 `~/.codex` 并打印统计。

## 发布 Release

推送与 `Support/Info.plist` 版本一致的标签后，GitHub Actions 会运行测试、构建 Universal DMG，并创建 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```
