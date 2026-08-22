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
- `.staging-*` / `plugins-clone-*` 要静置 1 小时以上才算残留——正在解包的升级从外面看长得一模一样。

### 会话记录

- 未归档与已归档会话统一列出：归档只是隐藏，不释放空间。
- 每个会话显示会话文件大小、内嵌图片占用和图片数量，并标记 Browser / Computer Use / ImageGen / 图片密集会话。
- 会话标题直接读 Codex 自己的 `~/.codex/state_*.sqlite`（`threads` 表的 `title`），
  和 Codex 界面里显示的短标题一致；按 `rollout_path` 和线程 id 两路匹配。
  该数据库只读打开，从不写入；WAL 状态下读不了时改读一份有大小上限的临时副本，用完即删。
- 读不到标题时才回落到第一句用户消息（`<environment_context>`、`<user_instructions>`、
  AGENTS.md 这类注入内容会跳过），再回落到项目名。
- 支持按占用、内嵌图片、最后活动或名称排序，可搜索标题/项目，并按「最后活动早于 N 天」批量选择。
- 过滤与排序结果有缓存，只在条件变化时重算，长列表滚动不会卡。
- 删除优先调用 app server 的 `thread/delete`，同时清理 rollout、关联元数据和派生子线程；
  没有 `codex` 命令行时退回到「移到废纸篓」，并同时处理 `generated_images` / `visualizations` 里的关联资产；
  这种回退方式不会更新 `state_*.sqlite` 里的线程索引，删除确认框会提示这一点。
- 默认不改写 JSONL。删除会话之外的操作都不碰会话文件内容。

### 会话瘦身（显式操作，默认不启用）

同一张截图会在多轮里随历史被反复写回 rollout —— 实测一个 295 MB 的会话里 114 处内嵌图片
只对应 22 张不同的图，其中一张重复了 50 次。所以"要么留着膨胀的会话、要么整条删掉"之外还需要中间档。

- **只去重**（默认方式）：保留每张图的第一份，后面的重复替换成 1×1 占位图。每张图都还在文件里。
- **剥离全部**：所有内嵌图片都换成占位图，省得最多，但这个会话里的截图从此看不到。
- 只有 `data:image/…` 到该 JSON 字符串结束引号之间的字节会被替换，其余每个字节逐字节原样复制，
  所以改写前是合法 JSON 的行改写后仍然是。base64 里不含引号和反斜杠，字符串边界不会被误判。
- 替换值是一张真实合法的 1×1 透明 PNG data URI，不是坏掉的引用。
- **Codex 正在运行时直接拒绝**，不是跳过；扫描期间仍在写入的会话也不参与。
- 写临时文件 → 校验行数一致 + 每行（超大图片行除外）仍能解析为 JSON → **原文件移到废纸篓** → 替换 →
  恢复原修改时间。任何一步失败都保持原文件不动。
- 自动清理**不会**做瘦身，只有手动勾选才执行。
- 列表里「内嵌图片」一列会显示其中有多少是重复的，可以按「可瘦身空间」排序。

### 插件版本

- 递归查找带 `.codex-plugin/plugin.json` 的版本目录，包括各自的 Python `.venv`。
- 通过 app server 的 `plugin/list` 确认当前版本；确认不了就全部标记为「未确认」并禁止清理。
- 只清理旧版本和卸载残留，当前版本和 `.plugin-appserver` 永远受保护。

### 自动清理

- 写入用户级 LaunchAgent（`com.finnaxxx.clean-my-codex.autoclean`），按设定周期运行 `CleanMyCodex --auto-clean`。
- **Codex 开着也照常运行**。缓存、临时文件、旧插件版本、过期会话都不需要关掉 Codex；
  只有需要独占文件的两件事会推迟到下一次：日志数据库压缩（`VACUUM` 必须独占）和会话瘦身
  （改写正在被追加的 rollout 会毁文件）。推迟的项目会写进日志和上次运行记录，不是失败。
- 可分别设置归档与未归档会话的保留天数，默认关闭；缓存与旧版本插件默认开启。
- 可选登录时启动（SMAppService）与完成后通知，运行记录写入 `~/Library/Logs/CleanMyCodex/autoclean.log`。

## 安全规则

- 普通文件一律**移到废纸篓**，不做不可恢复的删除。会话瘦身也一样：被替换的原始会话文件进废纸篓。
- 日志数据库只做 `wal_checkpoint(TRUNCATE)` → `VACUUM` → `integrity_check`，不删除诊断记录；
  Codex 运行时这一项推迟，其余照常清理。
- `config.toml` 里 `[marketplaces.*]` 声明的本地 source 目录一律受保护。Codex 把随版本内置的
  插件市场解包到 `~/.codex/.tmp/bundled-marketplaces/`，名字看着像临时文件，实际是
  `@openai-bundled` 那批插件（browser、computer-use、visualize 等）当前的加载来源；
  它旁边的 `openai-bundled.staging-<uuid>` 才是升级残留，可以清理。
- 保护是**双向包含**判定：目标在受保护路径之内会被拒绝，目标**包含**受保护路径同样被拒绝，
  否则删父目录就能绕过对子目录的保护。
### 工作产出（~/Documents/Codex）

Codex 每次会话的工作目录和产出文件——克隆的仓库、生成的中间文件、截图、导出物——按日期分组，
每个日期下再按会话分。这是**你的成果，不是缓存**，所以它走的是和普通清理不同的通道：

- 单独一个界面，按 日期 → 会话 展开，显示每一级的大小和文件数。
- **默认一项都不勾选**，每次扫描后选择都会清空；**自动清理永远不会碰这里**。
- 目录根 `~/Documents/Codex` 本身不可删除，只有它下面的子目录才能被选中，和 `~/.codex` 同一条规则。
- 会检测其中的 git 仓库，并用 `git status` / `@{upstream}..HEAD` 判断是否有**未提交改动或未推送提交**。
  这类内容只存在本地，删了无法从远端恢复，所以会在行内和确认框里单独标出；git 不可用时状态记为
  「未知」，按"不安全"处理，绝不当成可以放心删。
- 依然只是移到废纸篓。

- 以下内容永不清理：`auth.json`、`config.toml`、`state_*.sqlite`（含 WAL/SHM）、`rules`、`hooks`、
  用户 skills 与 memories、当前启用的插件版本、`~/Documents/Codex` 目录根本身，以及
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
