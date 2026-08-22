# CleanMyCodex

CleanMyCodex 是一个用 Electron、React 和 TypeScript 编写的 Codex 空间扫描与清理工具。

它会区分可重建缓存、需要确认的数据和永不清理的配置/凭据，并提供：

- Codex 缓存、临时目录、日志和 SQLite 空闲页扫描
- 通过 `codex app-server` 的 `plugin/list` 识别当前、旧版和卸载残留插件
- 会话列表、会话删除，以及 rollout 内嵌图片流式去重/剥离
- `~/Documents/Codex` 工作产出按需扫描和 git 未提交/未推送保护提示
- macOS LaunchAgent 定期自动清理
- macOS、Windows、Linux 安装包与 GitHub Actions CI/Release

## 开发

需要 Node.js 22 和 pnpm 11.19。

```bash
pnpm install
pnpm dev
```

`better-sqlite3` 是 Electron native module；安装后会由 `electron-rebuild` 按当前 Electron ABI 重建。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 打包

```bash
pnpm build:mac
pnpm build:win
pnpm build:linux
```

产物写入 `dist-electron/`。macOS 使用 `Support/AppIcon.icns`，若本机钥匙串存在可用签名身份，electron-builder 会自动签名；正式发布仍需配置 Apple notarization 凭据。

所有清理目标都在主进程再次经过路径保护。普通文件移入系统废纸篓；数据库压缩只执行 checkpoint/VACUUM；会话瘦身会保留原文件于废纸篓，并在替换前校验源文件未变化和 JSONL 行结构有效。
