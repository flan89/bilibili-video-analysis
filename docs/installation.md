# 安装与首次使用

本文件面向 Skill 使用者，说明如何安装、验证和按需准备运行环境。源码开发、测试和发布物生成见 [`development-guide.md`](development-guide.md)。

## 1. 运行要求

基础能力需要：

- 一个支持加载本地 Skill 并调用命令行工具的 Agent；
- Node.js 20 或更高版本；
- 能够访问 B站公开视频的网络环境。

元信息、官方字幕、弹幕、评论和回复等核心 Tool 不要求使用者安装项目的 npm 依赖。

以下依赖只在相关任务真正需要时准备：

- 视觉分析需要 `ffmpeg` 和 `ffprobe`；
- 无官方字幕视频的本地 ASR（自动语音识别）需要 `ffmpeg`、Python 隔离环境和模型文件。

首次模型下载可能占用较多时间和磁盘空间。Tool 不会自动安装环境；只有用户明确同意后，Agent 才能执行环境准备命令。

## 2. Pi 从 GitHub 直接安装

Pi 支持把 Git 仓库作为 Package（扩展包）安装：

```bash
pi install https://github.com/flan89/bilibili-video-analysis.git
```

也可以固定到标签或提交：

```bash
pi install git:github.com/flan89/bilibili-video-analysis@<tag-or-commit>
```

Pi 会：

1. 把完整仓库克隆到自己的包目录；
2. 读取 `package.json` 中的 `pi.skills`，发现根目录的 `SKILL.md`；
3. 仓库存在 `package.json` 时执行 `npm install`；
4. 本项目通过 `prepare` 自动生成 `dist/cli.mjs`；
5. 保留仓库自带的 `references/` 和 `runtime/`。

因此，Pi 从 GitHub 安装时不需要预先执行 `npm run release`。这里安装的是完整源码仓库，不是精简发布包。

这属于 Pi Package 的安装能力，不是所有 Agent Skills 实现都支持的通用行为。其它 Agent 是否支持 GitHub 地址、是否执行构建脚本，应以各自文档为准。

安装第三方 Skill 前应检查 `SKILL.md`、`package.json` 和相关可执行脚本。Pi Package 可以运行安装脚本，Skill 也可能指导 Agent 执行本地程序。

## 3. 使用正式发布包安装

正式发布目录应包含：

```text
bilibili-video-analysis/
├── SKILL.md
├── VERSION
├── LICENSE
├── references/
├── runtime/
└── dist/
    └── cli.mjs
```

安装步骤：

1. 从[项目发布页](https://github.com/flan89/bilibili-video-analysis/releases)下载并解压名称以 `bilibili-video-analysis-` 开头的 ZIP 或 tar.gz 正式包；
2. 将整个目录复制到目标 Agent 配置的 Skills 目录；
3. 确认最终路径形如 `<skills目录>/bilibili-video-analysis/SKILL.md`；
4. 重新加载 Agent，或按目标 Agent 的方式刷新 Skill 列表。

不同 Agent 的 Skills 目录位置可能不同，应以目标 Agent 的配置为准。不要把 GitHub 自动生成的 `Source code` 源码归档误当成正式包；源码归档不包含构建后的 `dist/cli.mjs`。也不要只复制 `SKILL.md` 或删除 `runtime/`，它们分别承担运行指令和可选媒体能力所需的辅助程序。

正式发布包已经包含打包后的 `dist/cli.mjs`，使用者不需要执行 `npm install` 或 `npm ci`。

## 4. 从源码生成发布包

如果项目暂未提供可下载的正式发布包，可以在源码仓库执行：

```bash
npm ci
npm run release
```

生成结果位于：

```text
release/bilibili-video-analysis/
```

把这个生成目录复制到 Agent 的 Skills 目录。源码仓库包含测试和开发文件，不应直接代替正式发布目录。

## 5. 首次验证

安装后，先向 Agent 提出一个低成本任务，例如：

```text
请使用 B站视频内容分析 Skill，概括这个公开视频讲了什么：<视频链接>
```

正常情况下，Agent 会按需读取 Skill 说明并调用元信息或字幕 Tool，然后直接回答问题。

如果需要手工检查命令行入口，可以在已安装 Skill 目录中执行：

```bash
node dist/cli.mjs doctor --json
node dist/cli.mjs tool metadata '{"video":"BV号或视频链接"}'
```

`doctor` 只检查环境，不安装软件，也不下载模型。

## 6. 按需准备视觉或语音识别环境

当 Tool 因缺少运行环境而返回 `setupHint` 时，Agent 可以先展示准备计划：

```bash
node dist/cli.mjs setup media --plan
node dist/cli.mjs setup asr --plan
```

只有用户确认计划后，才执行相应的 `--apply` 命令：

```bash
node dist/cli.mjs setup media --apply
node dist/cli.mjs setup asr --apply
```

ffmpeg 自动安装当前支持 macOS 的 Homebrew，以及 Ubuntu/Debian 的 apt。其它平台仍可使用不依赖媒体处理的核心 Tool；需要视觉或语音识别时，准备计划会给出手工安装提示。

不需要为了普通字幕视频预先安装语音识别环境。官方字幕已经足够完成任务时，Skill 不应主动要求安装额外依赖。

## 7. 更新与卸载

### Pi 安装

更新未固定版本的 Git 仓库包：

```bash
pi update --all
```
固定到标签或提交的安装不会自动移动到新版本，需要使用新的引用重新安装。

卸载：

```bash
pi remove https://github.com/flan89/bilibili-video-analysis.git
```

### 手工安装的发布包

更新时：

1. 获取新的完整发布目录；
2. 用新目录替换旧的 `bilibili-video-analysis`；
3. 重新加载 Agent；
4. 必要时再次运行只读环境诊断。

卸载时删除 Agent Skills 目录中的 `bilibili-video-analysis` 即可。

运行缓存、Python 隔离环境和模型位于独立的数据或缓存目录，不会因为删除 Skill 目录自动移除。如需释放空间，应先确认路径和用途，再由用户决定是否清理。
