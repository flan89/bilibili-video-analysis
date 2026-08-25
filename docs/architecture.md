# Agent Skill 架构设计

## 1. Skill 优先的总体结构

本项目的核心运行架构不是“程序内部顺序调用一组模块”，而是宿主 Agent 在 Skill 指导下反复观察、判断和调用原子能力：

```text
用户自然语言目标
        ↓
Task Routing
objective / intent / focus / depth
        ↓
Data Routing
required / optional / fallback
        ↓
Agent 按需读取 Tool Reference
        ↓
无状态原子 Tool 获取事实数据
        ↓
Agent 按需读取 Analysis Protocol
        ↓
宿主模型完成语义分析
        ↓
Grounding / Coverage
        ↓
回答用户并停止
```

---

## 2. 两级路由

### 2.1 Task Routing：认知路由

先回答：

> 用户这次真正要完成什么？

内部形成：

- `objective`
- `primary_intent`
- `secondary_intents`
- `focus`
- `depth`
- `clarification`

这一步**不由当前已有 Tool 反向定义**。

例如某项新任务需要的数据 Tool 尚未实现，也不能为了迁就现有能力而把它错误路由成另一种任务。

规则来源：

`references/task-routing.md`

### 2.2 Data Routing：能力/证据路由

Task Routing 完成后再回答：

> 为了可靠完成这个 Intent / Focus，最少需要什么证据？

输出：

- Required Data
- Optional Data
- Avoid by Default
- Fallback

Data Routing 同时考虑当前能力 Availability。如果 Required Data 尚未实现，Skill 应说明缺口，而不是修改用户任务让现有 Tool 勉强完成。

规则来源：

`references/data-routing.md`

---

## 3. Progressive Disclosure 文档架构

`SKILL.md` 是运行时主流程，不是 Tool 手册、开发说明或所有专业方法的汇总文件。

```text
SKILL.md
│
├─ 理解任务
│   └─ references/task-routing.md
│
├─ 规划证据
│   └─ references/data-routing.md
│
├─ 主题发现（仅 topic_research）
│   └─ references/discovery-strategy.md
│
├─ 获取数据
│   └─ references/tools/*.md
│
├─ 语义分析
│   └─ references/analysis/*.md
│
├─ Grounding / Coverage
└─ Answer / Stop
```

原则：

- 主文件只保留每次执行都需要的稳定主脉络；
- 只有当某一步真正需要时才读取对应 reference；
- 主题发现只在 `topic_research` 中加载；用户已给定具体视频时不进入搜索阶段；
- 当前公开能力会持续扩展，但不应把主 `SKILL.md` 降级成具体 Tool 的使用说明；
- 新增 Tool 时扩展 `references/tools/`；
- 新增认知能力时扩展 `references/analysis/`；
- 主 Skill 架构应尽量保持稳定。

---

## 4. Agent、Skill、Analysis Protocol 与 Tool 的职责

### Agent

负责需要语义理解和情境判断的工作：

- 理解用户真正想完成的事；
- 形成 Intent / Focus / Depth；
- 决定是否澄清；
- 根据 Data Routing 决定下一项数据能力；
- 阅读对应 Analysis Protocol；
- 判断章节、观点、理由、方法、步骤、案例和内容重要性；
- 比较多种来源；
- 区分事实、原始表达、归纳和推断；
- 根据用户目标组织最终回答。

### `SKILL.md`

负责稳定的 Runtime Orchestration：

- Task Routing → Data Routing → Acquire → Analyze → Ground → Answer；
- 什么时候读取更详细的 reference；
- 当前能力地图；
- 跨任务一致的 Coverage、Grounding 和 Stop 规则。

它不负责：

- CLI 参数细节；
- 平台错误码；
- 开发安装说明；
- 把所有 Intent 的专业分析细节全部写在主文件。

### Analysis Protocol

`references/analysis/*.md` 是 Skill 的专业认知资产。

它们回答：

> Agent 拿到证据以后，应该如何阅读、比较、判断和形成结论？

例如 `content-learn.md` 不只告诉 Agent“总结一下”，而是提供：

- Claim / Reason / Evidence / Example / Method / Condition / Caveat 等语义角色；
- 核心观点识别；
- 高价值知识筛选；
- 观点强度判断；
- 教程动作链恢复；
- 工具与适用场景映射；
- 定向问答的范围检索方法。

它们不是固定输出模板。

### Tool / Script

负责程序能够稳定、确定完成的工作：

- 外部 API；
- 媒体处理；
- 协议解析；
- 格式转换；
- 确定性清洗；
- 分页、范围读取和来源核对；
- 返回结构化完整性和失败状态。

具体调用方式只维护在：

`references/tools/*.md`

Tool 不负责语义总结、市场结论或最终报告，也不在内部再次调用大语言模型。

---

## 5. 原子 Tool 与状态边界

Tool 默认无状态并可独立调用：

```text
get_metadata(video)  → MetadataResult
get_subtitle(video)  → SubtitleResult
get_comments(video)  → CommentsResult
search_videos(query) → VideoSearchResult
get_popular_videos() → PopularVideosResult
get_hot_searches()   → HotSearchResult
get_related_videos(video) → RelatedVideosResult
```

每个结果只包含当前职责的数据、稳定视频引用和本次采集状态。

不要要求 Agent 在多个调用之间传递不断变大的聚合对象。

一个 Tool 可以内部取得完成自身职责必需的最小前置信息。例如字幕 Tool 可以内部取得 `aid/cid`，但不能顺便获取评论或执行内容分析。

当前不建立有状态 Tool Service、Asset Store 或跨调用进程内 Session。主题研究由 Agent 在上下文中关联搜索候选和后续的单视频 Tool 结果，不引入程序化的跨视频聚合对象。

关键词搜索、当前热门、热搜词和关联推荐是四种独立的发现来源。它们反映的平台机制不同，Tool 不把结果自动合并或统一排序；Agent 根据用户目标选择来源，并在回答中保留来源差异。

---

## 6. 代码目录职责

```text
scripts/
├── bilibili/       # 多个能力共享的B站请求、签名、错误和公共协议
├── cli/            # 统一 Runtime 命令入口与 Agent 紧凑视图
├── models/         # Tool 输入输出、VideoRef、来源对象和状态
├── metadata/       # 元信息 Tool
├── subtitle/       # 官方字幕与 ASR fallback
├── comments/       # 评论与回复 Tool
├── danmaku/        # 弹幕 Tool
├── discovery/      # 主题发现 Tool
└── visual/         # 视频流与关键帧 Tool
```

### `scripts/bilibili/*`

多个能力共同使用的平台基础层，例如请求客户端、WBI 签名、公共错误、通用二进制协议和播放地址解析。某个能力专属的接口协议不因来自B站就统一堆入此目录。

### 各能力目录

一类 Tool 解决一个明确的数据问题。该能力专属的 B站适配代码与 Tool 放在同一目录，使用 `bilibili-adapter.ts`、`bilibili-raw-schema.ts` 或带渠道名称的等价命名；适配文件负责把平台字段转换为稳定内部模型。

B站原始字段只能停留在这些平台适配文件和必要的公共协议文件中，不能扩散到 Tool 输出、确定性业务处理或 Skill 工作流。目录位置服从“领域专属代码就近放置、跨领域代码进入共享层”，不能演变成 `analyze_bilibili_video()`。

### `scripts/cli/*`

CLI 是当前 Agent 执行 Tool 的载体之一。它应接受 Agent 自然拥有的参数，例如视频 URL、BV号、分P和语言。

CLI 属于 Tool implementation detail。Runtime Agent 只有在 Data Routing 选择该能力以后，才通过对应 `references/tools/*.md` 了解具体命令。

正式发布时，TypeScript 与运行依赖会打包成 `dist/cli.mjs`。发布物不携带源码、测试、开发依赖和 `node_modules`，用户机器不执行 `npm install`。

统一入口只有三类职责：

```text
doctor  只读诊断
setup   先计划，用户授权后才修改环境
tool    调用一个原子数据能力
```

Skill 安装目录按只读处理；Python 隔离环境、模型和运行状态放入 Data Home，媒体、帧、ASR 中间文件和转写缓存放入 Cache Home。两者都允许通过环境变量覆盖。

### `scripts/models/*`

只为当前真实 Tool 契约服务，不为宿主 Agent 本来能完成的语义分析预先建立庞大固定模型。

确定性整理内聚在对应能力目录。技术性分页不是语义章节，程序不判断“什么最重要”。

---

## 7. `VideoRef` 与跨 Tool 关联

不同 Tool 使用轻量 `VideoRef` 表达结果属于哪个视频/分P：

```text
VideoRef
├── bvid
└── cid?
```

Agent 在自己的上下文中关联多次 Tool 结果。

---

## 8. 来源可回查与完整性

原始来源对象优先保留：

- 稳定来源编号；
- 视频 / 分P 身份；
- 时间或线程位置；
- 原始内容；
- 完整性和采集状态。

Evidence 首先是质量要求，而不是必须经过的程序化对象。

Agent 的重要结论要能回到这些来源；统一 Evidence Model 只有出现真实机器消费者时再设计。

Coverage 是与 Grounding 同级的质量维度：有证据不代表覆盖完整。全片任务不能只依赖部分字幕或部分数据。

---

## 9. 后续能力如何扩展

新增能力遵守同一结构：

```text
Task Routing 不变
  ↓
Data Routing 增加可用数据映射
  ↓
新增 references/tools/<capability>.md
  ↓
新增 scripts Tool
  ↓
如产生新的认知任务，再新增 references/analysis/<intent>.md
```

例如新增观众洞察能力时，不应把评论抓取和完整分析方法全部写进 `SKILL.md`；只增加必要的 Tool Reference 和 `audience-insight.md`。
