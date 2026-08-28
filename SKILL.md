---
name: bilibili-video-analysis
description: 从主题搜索、B站当前热门或热搜、给定视频的关联推荐或具体视频开始，把视频正文、画面、弹幕、评论和回复转化为可回查的学习与研究结果。适用于查找和比较B站视频、总结教程与观点、拆解视觉表达、分析观众反馈，以及用户明确提出的产品或市场研究；Skill 按目标获取最小证据，并在数据不足时明确降级。
license: MIT
compatibility: 核心数据获取需要 Node.js >=20 及可访问B站的网络；视觉分析另需 ffmpeg/ffprobe，本地 ASR 还需 Python >=3.10、隔离环境与首次模型准备。
---

# B站视频分析

这个 Skill 的核心不是“把所有视频数据抓回来”，而是：

> **围绕用户真正的问题，取得足够而不过量的证据，再用匹配的方法完成分析。**

始终沿着这条主链工作：

```text
用户目标
  → Task Routing
  → Data Routing
  → 获取必要数据
  → 按 Intent / Focus 分析
  → Grounding / Coverage
  → 回答并停止
```

逻辑步骤不能跳，但只读取当前任务真正需要的 reference；不要为了遵守流程把所有 Tool / Analysis 文档全文加载进上下文。

## 1. Task Routing：先理解问题

先读取 [`references/task-routing.md`](references/task-routing.md)，内部形成：

- `objective`：用户真正想完成什么；
- `primary_intent`：主要认知任务；
- `secondary_intents`：确有必要时才增加；
- `focus`：这次具体要观察、提取或判断什么；
- `depth`：`quick | standard | deep`；
- `clarification`：是否必须先澄清。

当前 Intent：

- `content_learn`
- `visual_decode`
- `audience_insight`
- `market_research`
- `topic_research`
- `overview`

Focus 是开放集合，不要把测试 case 里的字符串当白名单。

只有当不同合理解释会显著改变数据路径或分析方法、且低成本步骤无法兼顾时，才问一个简短澄清问题。

**当前 Tool 是否可用，不能反向修改用户真实 Intent。**

用户没有提供具体视频、而是给出主题或问题时，属于 `topic_research`：先按 [`references/discovery-strategy.md`](references/discovery-strategy.md) 发现候选，再对选中视频复用单视频流程。单视频任务不加载该策略。

## 2. Data Routing：再决定需要什么证据

读取 [`references/data-routing.md`](references/data-routing.md) 中与当前 Intent / Focus 相关的部分，再规划：

- `required`：缺失后无法可靠完成目标；
- `optional`：可能增强答案，但默认不获取；
- `avoid_by_default`：当前任务下通常不应获取；
- `fallbacks`：Required Data 缺失时才考虑的替代路径。

遵守两个全局原则：

1. **最小获取**：已有证据足够回答时停止取数；
2. **Coverage 优先**：节省成本不能偷偷缩小用户要求的范围。

TaskPlan 结构只用于内部路由和 Eval；普通用户回答不要展示内部计划：

- [`references/data-plan-schema.md`](references/data-plan-schema.md)

## 3. Tool：只读取实际要用的能力文档

Tool 负责外部数据与确定性处理，不负责语义结论。

| 数据能力 | Tool reference |
|---|---|
| 视频搜索（仅 `topic_research` 阶段一） | [`references/tools/video-search.md`](references/tools/video-search.md) |
| 当前热门快照（平台热门机制，非排行榜） | [`references/tools/popular-videos.md`](references/tools/popular-videos.md) |
| 当前热搜词条（搜索关注度快照，非事件背景） | [`references/tools/hot-searches.md`](references/tools/hot-searches.md) |
| 给定视频的关联推荐（推荐邻接关系，非主题等价） | [`references/tools/related-videos.md`](references/tools/related-videos.md) |
| 视频元信息 | [`references/tools/metadata.md`](references/tools/metadata.md) |
| Transcript（官方字幕 + ASR fallback） | [`references/tools/subtitle.md`](references/tools/subtitle.md) |
| 弹幕 | [`references/tools/danmaku.md`](references/tools/danmaku.md) |
| 评论 / 回复 | [`references/tools/comments.md`](references/tools/comments.md) |
| 关键帧 / 视觉变化候选 | [`references/tools/frames.md`](references/tools/frames.md) |

只有 Data Routing 确定需要某项数据时，才读取对应 Tool reference，并按其中的当前契约调用。

命令行调用可以优先使用 Tool reference 推荐的紧凑输出，并尽量复用已经取得的成功结果；紧凑输出中的采集状态和 `warnings` 仍是结论边界的一部分。

### 3.1 统一理解 Tool 结果

不同 Tool 的业务数据不同，但 Agent 应统一先判断：

- 顶层执行结果：使用 `outcome` 的 Tool 检查成功、缺失、需要选择或失败；Discovery Tool 检查 `success`；具体语义以对应 Tool reference 为准；
- `acquisition.status`：`success / partial / missing / failed` 等采集状态；
- `reasonCode / error`：失败原因与是否可重试；
- `warnings`：不阻止返回数据、但会影响证据强度或 Coverage 的信息；
- 数据本身是否为空、是否完整、是否只覆盖部分范围。

**Failure / Empty / Partial 不是同一件事：**

- Failure：没拿到需要的数据 → 判断 retry / fallback / capability gap；
- Empty：Tool 成功但没有观察到数据 → 不把“没观察到”改写成“现实中不存在”；
- Partial：可以分析已取得部分，但必须降低结论范围并公开缺口。

具体字段和 reasonCode 以各 Tool reference 为准，不在这里重复维护完整契约。

### 3.2 数据源强度是证据的一部分

例如 Transcript 可能来自：

- `official`：UP 主上传字幕；
- `official_ai`：平台生成字幕；
- `asr`：本地 ASR 转写。

平台字幕和 ASR 中的人名、产品名、数字、专业术语可能识别错误。重要结论依赖这些实体时，应结合上下文核对，并在无法确认时降低表述强度。

其它来源的具体语义（弹幕即时性、评论线程、Frame Coverage 等）由对应 Analysis / Tool reference 说明。

## 4. Analysis：Intent + Focus 决定怎么思考

只读取当前使用的 Analysis Protocol，并重点阅读“通用原则 + 当前 Focus”相关部分：

- `content_learn` → [`references/analysis/content-learn.md`](references/analysis/content-learn.md)
- `visual_decode` → [`references/analysis/visual-decode.md`](references/analysis/visual-decode.md)
- `audience_insight` → [`references/analysis/audience-insight.md`](references/analysis/audience-insight.md)
- `market_research` → [`references/analysis/market-research.md`](references/analysis/market-research.md)
- `topic_research` → [`references/analysis/topic-research.md`](references/analysis/topic-research.md)

Analysis Protocol 提供的是**阅读与判断方法**，不是固定报告模板。最终结构服从用户问题。

## 5. 多 Intent：共享数据，分开语义，最后综合

用户问题同时涉及多个 Intent 时，不需要新的 Orchestrator，也不要为每种组合造协议。

按以下原则组合：

```text
各 Intent 分别确定 Focus
  ↓
Required Data 求并集
  ↓
同一种数据只获取一次
  ↓
分别按各自 Analysis Protocol 理解
  ↓
只在证据允许时做跨源综合
```

关键边界：

- **数据可以跨 Intent 复用**：Transcript、Comments、Danmaku、Frames 不属于某个 Intent；
- **语义不能串味**：同一评论在 audience 中可以是 Concern，在 market 中可以进一步成为 Pain 候选，但两个判断必须分别满足各自协议；
- Optional Data 不因“多 Intent”自动升级成 Required；
- 某一个 Intent 的 Required Data 失败，不等于整项任务失败：完成其它证据足够支持的部分，并明确缺口；
- `market_research` 的单视频边界不会因为与其它 Intent 组合而变松；跨多个视频也只能增强机会假设，不能升级为“市场已验证”。

## 6. Grounding：结论要能回到来源

重要结论形成前检查：

- 作者明确表达、Agent 归纳、Agent 推断是否区分；
- 评论 / 回复 / 弹幕观点是否被误写成作者观点；
- 直接引用是否与来源一致；
- 重要结论能否定位到字幕时间、评论 / 回复 ID、弹幕时间或 Frame 时间；
- 标题、简介、分P标题是否被误当成正文证据；
- ASR / 平台字幕术语错误是否可能改变结论；
- 视觉中的“作用”、市场中的“机会”、Audience 中的“共识”等是否被误写成直接事实；
- 跨视频结论是否定位到了具体视频（BV 号 + 字幕时间 / 评论 ID / 弹幕时间 / Frame 时间），而不是只说“多个视频都提到”。

不必机械给每句话加引用，优先保证**影响结论的证据可回查**。

## 7. Coverage：有证据不等于覆盖完整

回答前检查：

- 用户要求的是局部、样本还是全片 / 全部；
- 是否存在 partial、缺失分P、抽样、未展开回复、未覆盖时间段或失败数据源；
- 当前数据是否支持“整体 / 多数 / 高频 / 共识 / 全片”等强词；
- 数据为空时，是否只是“当前样本没有观察到”；
- 主题研究是否公开了搜索范围：搜索词、查询时间、查看的候选量、深入分析的样本和创作者数量；
- 当前缺口会不会实质改变结论。

**不能把局部数据写成整体结论。**

## 8. 回答用户，然后停止

最终回答直接解决用户原始问题，不展示 TaskPlan、Tool JSON、CLI 日志、Eval 规则或内部协议章节号。

达到以下条件时停止：

- 用户真正的问题已经回答；
- 关键结论有足够依据；
- 用户要求的范围已经覆盖，或已明确说明无法覆盖的部分；
- 继续取数不会明显改变当前结论。

不要为了显得专业，把简单问题自动扩张成全片、全评论区、视觉拆解或市场研究。

## 9. Environment Gate：Tool 失败时如何处理外部依赖

Skill 运行依赖两类外部环境：

- **Core 依赖**：Node.js（≥ 20）+ B 站网络。不依赖本地媒体处理和 ASR 环境的 B站 API 数据获取能力默认以匿名状态请求公开数据。
- **Lazy 依赖**：ffmpeg（视觉分析 + ASR 音频抽取）、Python 隔离 venv + FunASR（无字幕视频转录）。

**核心原则**：Tool 永远不自动安装。Tool 失败时返回 `setupHint` 字段，Agent 根据 `setupHint` 引导用户授权后调用 setup 命令。

评论和回复使用 WBI 签名，但签名不等于登录。当前正式命令行入口不会自动读取浏览器 Cookie，也没有公开的登录状态注入入口。匿名评论请求可能成功，也可能只返回有限数据、空数据或业务错误。没有明确可执行的身份接入能力时，不要把“登录浏览器后重试”当成已支持方案；应根据采集状态公开缺口并降级回答。

### Tool 决策流程

1. 调 Tool → 正常执行。
2. Tool 因运行环境缺失而返回 `failed` / `missing`，且输出包含 `setupHint`：
   - 查看 `setupHint.capability`（`media` / `asr`）
   - `doctorCommand` 只检查环境；`planCommand` 展示变更与成本；`applyCommand` 才真正修改环境
   - 告诉用户当前缺什么、用途、首次安装成本
   - **等用户明确同意**后，按 `executable + args` 执行 `setupHint.applyCommand`
   - setup 完成后重试 Tool
3. Tool 失败但**没有** `setupHint`：是 Tool 内部数据问题（网络/API/视频本身缺数据），不属环境问题，按 Tool 返回的 `acquisition.reasonCode` 跟 `message` 处理。

### Optional Data 缺依赖：默认不触发安装

例如用户只问"总结视频核心观点"，官方字幕已经够用。即使 ASR 跟 ffmpeg 都没装，也**不应该**提示用户去装。

只有当 Required Data 缺依赖时，才按上述流程走 Environment Gate。

### 何时主动检测

不需要每次都跑 `doctor`。只在 Tool 返回 `setupHint` 时，或者用户明确问“环境怎么样”时，执行 `setupHint.doctorCommand`。

### Plan vs Apply

`setup <phase> --plan` 只输出计划（不修改机器）。`setup <phase> --apply` 才执行。`setup asr` 会同时检查 ASR 所需的 ffmpeg。Agent 应先运行 `setupHint.planCommand` 并解释成本，用户同意后才能运行 `setupHint.applyCommand`。

更多细节见 `references/analysis/visual-decode.md`（视觉依赖 ffmpeg）和 `references/analysis/market-research.md` 不涉及环境依赖。
