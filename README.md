# CleanMyCodex

macOS 上的 Codex 空间扫描与清理工具。

## 功能

- 扫描 Codex 缓存、日志、临时文件和插件版本。
- 分别列出未归档与已归档会话。
- 统计每个会话的总占用和内嵌图片占用。
- 按大小、图片占用或最后活动时间排序。
- 预览清理和会话删除清单。

当前版本不会修改或删除文件。

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

默认扫描 `~/.codex`。可通过 `CODEX_HOME` 指定其他目录。

## 发布 Release

推送与 `Support/Info.plist` 版本一致的标签后，GitHub Actions 会运行测试、构建 Universal DMG，并创建 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```
