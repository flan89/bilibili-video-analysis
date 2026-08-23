# B站视频内容分析助手 Skill

这是一个供 Agent 使用的 B站视频内容分析 Skill。它既可以从具体视频开始，也可以先按主题搜索B站候选视频；随后根据用户目标，从字幕、画面、弹幕、评论和回复中取得必要信息，再使用 Agent 自身模型完成学习、拆解和分析，并让重要结论能够回查到原始位置。

项目不在 Tool 内部调用第二套模型，也不要求使用者额外配置模型地址或密钥。程序只负责外部数据获取、媒体处理和确定性整理；内容理解和最终回答由宿主 Agent 完成。

## 核心能力

- 学习视频中的知识、观点、方法和教程步骤；
- 从关键词搜索、当前热门、热搜词和关联推荐中发现候选视频，并对少量选中视频进行跨视频比较；
- 拆解画面、演示文稿、字幕、剪辑节奏和信息呈现方式；
- 理解弹幕、评论和回复中的观众反馈；
- 在用户明确提出产品、需求、竞品或商业目标时，辅助整理所选视频样本中的市场信号；
- 获取并标准化视频元信息、官方字幕、弹幕、评论、回复和关键帧；
- 官方字幕缺失时，可按需使用本地 ASR（自动语音识别）取得转写；
- 保留字幕时间、弹幕时间、评论编号、回复关系和画面时间，便于回查来源；
- 用结构化状态表达数据缺失、部分成功和失败，避免把局部数据写成整体结论。

## 已有 Tool 与分析协议

当前提供 10 个可独立调用的数据 Tool：

| Tool | 作用 |
|---|---|
| `search-videos` | 按一个搜索词取得一页候选视频，供主题发现阶段使用 |
| `popular-videos` | 获取B站当前热门视频候选 |
| `hot-searches` | 获取B站当前热搜词，辅助规划进一步搜索 |
| `related-videos` | 获取指定视频的关联推荐候选 |
| `metadata` | 获取标题、简介、标签、作者和分P等视频元信息 |
| `subtitle` | 获取官方字幕；缺失时按需尝试本地语音转写 |
| `danmaku` | 获取带视频时间位置的弹幕 |
| `comments` | 分页获取根评论 |
| `comment-replies` | 获取指定根评论的回复线程 |
| `frames` | 按时间点、间隔或视觉变化抽取关键帧 |

Agent 取得数据后，根据任务读取对应的 Analysis Protocol（分析协议）：

| 分析协议 | 适用任务 |
|---|---|
| `content-learn` | 学习知识、观点、教程和方法 |
| `visual-decode` | 分析画面、演示、剪辑和表达方式 |
| `audience-insight` | 理解弹幕、评论和回复中的观众反馈 |
| `market-research` | 用户明确要求时整理产品、需求和竞品信号 |
| `topic-research` | 从主题搜索候选，并对选中视频进行跨视频研究 |

这些协议提供专业的阅读和判断方法，不是固定报告模板，也不可能预先覆盖所有人的特殊场景。扩展方法见[开发指南](docs/development-guide.md#7-扩展-tool-和分析协议)。

## 适合哪些任务

安装后可以直接向 Agent 提出自然语言问题，例如：

```text
帮我总结这个 B站视频的核心观点，并标出对应时间。

把这个教程整理成可执行步骤，提醒我哪些条件和限制不能忽略。

分析这个视频的 PPT、构图和剪辑节奏是怎么服务内容表达的。

结合弹幕和评论，看看观众最关注什么、有哪些分歧。

这个视频讨论的产品暴露了哪些用户问题？只总结当前视频能支持的信号，不要把它写成市场已经验证。

帮我搜索B站上关于 Agent Skill 设计的视频，选择几个侧重点不同的样本，比较它们共同强调的方法和主要分歧。
```

Skill 会先理解问题，再只调用完成当前目标所需的数据能力，不会默认抓取全部来源。

## 安装

### Pi Agent

Pi 可以直接从 GitHub 安装：

```bash
pi install https://github.com/flan89/bilibili-video-analysis.git
```

### 其它 Agent

下载项目发布页中的正式 `bilibili-video-analysis` 发布包，将整个目录复制到目标 Agent 配置的 Skills 目录，然后重新加载 Agent。

不要只复制 `SKILL.md`。这个 Skill 还需要 `references/`、`runtime/`、`dist/cli.mjs` 和 `VERSION`。

完整安装、环境准备和验证方式见 [`docs/installation.md`](docs/installation.md)。

安装后直接向 Agent 提问即可，例如：

```text
请使用 B站视频内容分析 Skill，总结这个视频的核心观点并标出对应时间：<视频链接>
```

## 工作方式

```text
用户目标
  → Agent 判断任务和关注点
  → 规划完成任务所需的最小数据
  → 按需调用原子 Tool
  → Tool 获取并确定性整理数据
  → Agent 使用自身模型分析
  → 检查来源与覆盖范围
  → 回答用户并停止
```

关键边界：

- Tool 默认无状态，并且只返回自身职责的数据；
- B站原始字段只停留在平台适配层；
- Agent 负责语义理解，Tool 不生成固定分析报告；
- 市场研究必须由用户明确触发；
- 单个或少量视频只能提供信号和待验证假设，不能证明市场成立。

详细设计见 [`docs/architecture.md`](docs/architecture.md)。

## 当前范围

当前版本支持两种入口：分析用户给出的具体 B站视频，或从关键词搜索、当前热门、热搜词和关联推荐中发现候选，再对少量选中视频进行主题研究。单视频流程支持内容学习、视觉拆解、观众洞察，以及用户明确要求时的产品或市场研究；主题研究复用同一组原子 Tool，不会自动抓取全部候选和全部数据来源。

当前不提供：

- B站全站穷举、实时监控、历史趋势追踪或完整榜单枚举；
- 跨大量视频的趋势验证；
- 自动创业决策或市场规模判断；
- 长期个人知识库管理；
- 在没有足够证据时自动扩大结论范围。

完整产品目标和边界见 [`docs/product-vision.md`](docs/product-vision.md)。

## 开发与扩展

如果要从源码构建、运行测试、增加数据 Tool，或扩展特定场景的 Analysis Protocol，请阅读 [`docs/development-guide.md`](docs/development-guide.md)。普通使用者不需要了解源码目录或执行开发命令。

## 文档

- [`docs/installation.md`](docs/installation.md)：安装、更新、环境准备与首次验证；
- [`docs/product-vision.md`](docs/product-vision.md)：产品目标、使用模式和能力边界；
- [`docs/architecture.md`](docs/architecture.md)：Agent、Skill、分析协议与原子 Tool 的职责；
- [`docs/asr.md`](docs/asr.md)：官方字幕缺失时的本地语音转写方案；
- [`docs/development-guide.md`](docs/development-guide.md)：源码构建、测试、调试和发布验收。

具体运行规则从 [`SKILL.md`](SKILL.md) 开始，并由它按任务引导 Agent 读取 `references/` 中的相关内容。

## License

本项目采用 [MIT License](LICENSE)。
