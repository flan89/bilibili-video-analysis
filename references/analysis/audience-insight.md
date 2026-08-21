# Audience Insight Analysis Protocol

> 适用 Intent：`audience_insight`
>
> 目标是理解**观众如何反应、讨论、质疑、补充和相互回应**。不要把弹幕、评论和回复混成一个文本池，也不要把样本中的声音直接写成“观众普遍认为”。

最终输出结构服从用户问题。

## 1. 三类观众证据不是同一种东西

### Danmaku：即时反应

适合观察：

- 某个时间点突然增强的反应；
- 即时疑问、共鸣、吐槽、刷梗；
- 讲解过程中局部反应的变化。

弹幕密度不等于赞同。重复文本可能是共鸣，也可能是梗、跟风或 spam。

### Comments：观看后的显式反馈

适合观察：

- 观点和评价；
- 使用经验；
- 问题与担忧；
- 对作者结论的补充、修正、反例；
- 比较和建议。

高赞是 Engagement 信号，不等于代表性。

### Replies：讨论现场

适合观察：

- 某个观点如何被支持 / 反驳；
- 同一问题是否被多人确认；
- 条件、反例和上下文；
- 争议双方为什么不同意。

回复必须保留 parent/root 语境。一级评论里的回复预览不能当成完整线程。

## 2. 常见语义角色

按需要识别，不要求每条都分类：

- `Reaction`：即时反应；
- `Agreement`：明确赞同；
- `Disagreement`：明确反对；
- `Question`：提问；
- `Confusion`：没理解；
- `Experience`：亲身经历；
- `Confirmation`：确认“我也如此”；
- `Counterexample`：反例；
- `Correction`：纠错；
- `Concern`：担忧；
- `Complaint`：抱怨；
- `Suggestion`：建议；
- `Comparison`：与其它方案比较；
- `Meta`：对视频制作 / 作者表达的反馈；
- `Noise`：无关、刷梗、无明确语义。

语义角色是理解工具，不是固定输出模板。

## 3. 不要混淆 Frequency / Engagement / Intensity / Breadth

- `Frequency`：多少**独立证据**表达类似内容；
- `Engagement`：点赞、replyCount、线程长度、弹幕密度等互动强度；
- `Intensity`：表达本身有多强烈；
- `Breadth`：是否跨不同用户、时间、线程或来源独立出现。

一条高赞评论可能 Engagement 很高，但 Frequency / Breadth 很低。

Breadth 通常比单条高赞更适合支撑“不是孤立现象”。

## 4. Focus-specific 阅读策略

### 4.1 `discussion_topics`

目标是恢复**讨论主题结构**，不是逐条摘要。

1. 判断评论主要在讨论什么；
2. 合并语义近似主题；
3. 区分视频内容、使用经验、疑问、争议、Meta 等；
4. 判断各主题的 Frequency / Engagement / Breadth；
5. 保留代表性证据。

Hot / 单页 / sampling 数据只能描述“当前样本中的主要主题”。

### 4.2 `resonance`

优先使用 Danmaku：

```text
Danmaku timeline
  → 找局部反应增强
  → 判断主要反应语义
  → 需要解释触发原因时补上下文
```

触发原因可能来自：

- 作者口播 → Transcript；
- 画面展示 → Frames；
- 两者共同作用 → 两种证据一起看。

不要把“弹幕变多”直接写成“观众认同”。

### 4.3 `danmaku_peaks` / `high_engagement_segments`

区分：

- 数量峰值；
- 重复文本峰值；
- 疑问峰值；
- 争议峰值；
- 刷梗 / 表情峰值。

解释“为什么这里高”时，不要默认 Transcript 一定足够；先判断触发信息来自声音还是画面。

如果弹幕数据 partial 或有 segment failure，只能分析已覆盖区间，不能比较全片峰值。

### 4.4 `confusion`

结合：

- Danmaku：当场没听懂；
- Comments：看完仍有疑问；
- Replies：其他用户是否澄清。

需要判断：

- 对应视频哪段内容；
- 是偶发还是重复出现；
- 回复是否已有解释；
- 是否存在不同解释。

如果问题依赖屏幕信息，也可以补 Frames。

### 4.5 `repeated_questions`

不要只按关键词计数，先把语义等价问题归并。

例如：

- “Windows 能用吗？”
- “支持 win 吗？”
- “只有 Mac？”

可以归为同一问题簇。

再判断：

- 有多少独立提问；
- 是否跨时间出现；
- 是否已有回复；
- 视频正文 / 画面是否已经解释。

“视频讲了但仍被重复问 → 可能解释不够显著”是 Agent 归纳，不是观众原话。

### 4.6 `controversy`

恢复争议结构：

```text
Disputed Topic
  ↓
Position A → Reason / Experience
  ↓
Position B → Reason / Experience
  ↓
Counterexample / Correction
  ↓
Unresolved Point
```

不要把“有正面、有负面”当成争议分析。

优先深挖与 Focus 强相关、replyCount 高或存在明显反例的线程。

双方只是场景 / 版本 / 条件不同，不要硬写成“两极分化”。

### 4.7 `opinion_distribution` / `consensus`

这是高风险 Focus。

评论和弹幕通常不是概率抽样，所以默认分析：

> **当前样本里出现了哪些立场，它们有多少独立证据、覆盖多广、是否存在强反例。**

#### 非概率样本默认不要输出百分比

以下数据通常不适合输出“43% / 57%”之类比例：

- hot 排序；
- 连续 time 样本；
- hot + time 拼接样本；
- selected replies；
- 目的性采样；
- 类别可以重叠的主题归类。

优先写：

> “当前 7 条根评论样本中，3 条明确质疑 X，2 条表达 Y；其余没有直接表态。”

只有当前集合确实完整、统计口径互斥且用户问题需要比例时，才考虑给集合内部比例；即使如此也只能说“当前评论集合”，不能写成“观众比例”。

#### Evidence Absence 不等于 Agreement

**没有观察到反对 ≠ 支持。**

如果样本里没有人反驳某个观点，只能说：

> “当前样本中没有观察到直接反驳。”

不能进一步写：

> “评论基本认可这个观点。”

共识至少需要可观察的 Agreement / Confirmation / 独立收敛证据，而不是“没人反对”。

### 4.8 `cross_channel_consistency`

分别理解：

```text
Danmaku = 当时反应
Comments = 观看后反馈
```

再比较：

- 两边是否关注同一主题；
- 即时情绪是否转化成稳定观点；
- 是否存在“当时很热闹、评论几乎不讨论”的差异；
- 差异是否可能由 sampling / 时间范围导致。

不要把两类数据做一个简单情感平均。

### 4.9 `shared_concerns`

重点找：

- 多个独立用户重复担忧；
- 不同线程中的同类风险；
- 具体使用场景下的 Concern；
- Counterexample 是否说明担忧只在特定条件成立。

“重复担忧”仍然只是 Audience Signal；用户没有商业目标时不要自动升级成 Market Opportunity。

### 4.10 `audience_segments`

只做与当前问题直接相关的窄范围分群，例如：

- 新手 vs 有经验用户；
- 已使用 vs 未使用；
- 不同使用场景；
- 不同问题类型。

必须来自用户公开自述或当前表达，不推断没有证据的人口属性。

### 4.11 `same_problem_validation`

用户问“他们遇到的是不是同一个问题”时：

1. 先定义问题的核心症状 / 条件；
2. 找独立 Experience / Confirmation；
3. 检查环境、版本、场景是否相同；
4. 把看似相同但根因不同的问题拆开；
5. 深挖必要的 replies。

输出“同一种 / 几种不同问题”时给出分桶依据，不只做关键词聚类。

## 5. Replies 什么时候值得深挖

优先在以下情况获取 selected replies：

- 根评论语义高价值但条件不清；
- replyCount 高且与 Focus 强相关；
- 要验证“是否多人如此”；
- 要理解争议理由；
- 已有证据不足以判断反例 / 条件。

一级评论已经足够回答时，不为了完整抓回复。

## 6. 代表性：先判断“我看到了什么样的样本”

在任何整体判断前至少知道：

- hot 还是 time；
- 几页、每页多少；
- complete / partial；
- 是否有 purposeful sampling；
- selected replies 是否只覆盖部分线程；
- Danmaku 是否覆盖全部目标时间；
- 是否有 warning / failed segment。

### Hot

适合发现高互动主题和争议，不适合估计总体比例。

### Time

适合观察近期反馈和时间变化，但连续最新评论仍不是随机样本。

### 单页

适合 quick discovery，不适合“整个评论区都在……”这类强结论。

### 多页 / Deep

采用渐进式获取：

```text
先取一部分
  ↓
识别主题与 Evidence Gap
  ↓
补不同页 / 排序 / selected replies
  ↓
判断继续取数是否还有信息增益
```

Saturation 只是一种成本控制启发，不能证明统计代表性。

## 7. Danmaku 的特殊处理

### 时间窗口

按视频节奏观察合理邻域，例如 `t-5s ~ t+5s`，不要机械把每秒切成统计表。

### 重复文本

重复可能表示：共鸣、梗、跟风、口令或 spam。需要结合文本、时间集中程度、上下文和发送者去重信息判断。

### 用户去重

`midHash` 只用于去重 / 关联匿名事件，不反查真实身份，也不在用户回答中暴露。

### weight

除非 Tool reference 提供可靠语义，否则不要把平台 `weight` 解释成用户可信度、情绪强度或观点质量。

## 8. 评论线程必须保留语境

至少保持：

```text
Root Comment
  ↓
Reply
  ↓
Parent / Context
```

“是的”“我不是这个意思”“你看错了”等回复脱离 parent 后没有可靠语义。

线程是否完整以真实分页 Coverage 为准，不根据单个节点的预览字段推断。

## 9. 信号强度不是一个分数

可以综合：

```text
Frequency
+ Breadth
+ Engagement
+ Evidence Specificity
+ Cross-source Confirmation
- Sampling Bias
- Ambiguity
```

不需要计算固定数学分数。

较强：多个独立线程、具体经历、跨时间重复、回复确认、跨来源一致。

较弱：单条高赞、一个用户反复留言、纯情绪、置顶评论、一次刷屏、需要大量猜测。

## 10. Evidence Gap：需要时补 Transcript 或 Frames

Audience Insight 不默认等于 `comments + transcript`，也不禁止视觉数据。

需要理解观众“在回应什么”时，选择**真正承载触发信息的来源**：

- 作者口播 / 观点 → Transcript；
- 屏幕文字 / UI / 图示 / 意外画面 → Frames；
- 两者都有 → 最小必要组合。

例如：

```text
用户：为什么 03:20 弹幕突然全是“卧槽”？
  ↓
先看弹幕
  ↓
如果 03:20 作者口播了惊人数字 → transcript
如果作者没说话、只展示图表 → frames
```

这不是把 `audience_insight` 改成 `visual_decode`。Frames 只是观众反应的上下文证据；最终分析仍回答“观众如何反应”。

## 11. 多来源先分层，再融合

先分别理解：

```text
Creator Content = 作者表达什么
Visual Context  = 当时画面显示什么
Danmaku         = 当时观众如何反应
Comments        = 观看后如何反馈
Replies         = 某个反馈如何被讨论
```

最后才分析关系。

这样避免：

- 把观众观点写成作者观点；
- 把作者解释写成观众共识；
- 把画面观察写成观众态度；
- 把即时弹幕当稳定评价。

## 12. 与 `market_research` 的边界

Audience Insight 可以识别重复抱怨、问题、Experience、Comparison、Suggestion 等。

但用户没有明确商业目标时，不进一步输出：

- 创业机会；
- 市场需求大小；
- 付费意愿；
- “应该做某产品”。

如果用户明确要求 Pain / Job / Competitor / Purchase Intent / Opportunity Hypothesis 等商业判断，应增加 `market_research`，并按 [`market-research.md`](market-research.md) 的协议重新解释相关证据。

同一数据可以被两个 Intent 复用，但语义判断分别成立。

## 13. Grounding

重要 Audience Insight 尽量回到：

- Danmaku：视频时间 + 代表文本；
- Comments：rpid + 文本；
- Replies：root / reply + parent 语境；
- 需要上下文时：Transcript 时间或 Frame 时间。

不要为了证明结论堆大量原文；保留区分度高的证据。

## 14. Coverage

最终回答前检查：

- 抓了几页；
- 排序是什么；
- 是否 complete；
- replies 是否只覆盖部分线程；
- danmaku 是否覆盖目标时间；
- 是否存在 partial / failed segment；
- 当前样本是否支持“主要 / 高频 / 多数 / 共识”。

表述强度应跟 Coverage 匹配。

## 15. Privacy

只分析公开表达和任务相关行为信号。

默认不暴露 UID、midHash、头像 URL 或无必要昵称，不根据这些字段推断敏感或无证据的人口属性。

## 16. Depth

### `quick`

最小数据，找最明显信号，不主动展开大量 replies。

### `standard`

形成有证据的主题 / 分歧结构，按需补 selected replies、Transcript 或 Frames。

### `deep`

扩大页数、不同排序和关键线程，检查 Breadth、Contradiction 和代表性边界。

Deep 也不等于默认抓完整评论区所有回复。

## 17. 多 Focus 组合

Primary Focus 决定主问题，Secondary Focus 只补用户明确关心的部分。

例如：

```text
discussion_topics
  ↓
定位讨论簇
  ↓
controversy
  ↓
深挖争议线程
  ↓
repeated_questions
  ↓
补重复疑问
```

不要为每个 Focus 输出独立小报告。

## 18. 输出前自检

- 我仍然在回答 Audience 问题，没有无意升级成 Market？
- 有没有把 Danmaku 即时反应当稳定观点？
- 有没有把高赞当观众比例？
- 非概率样本是否错误输出百分比？
- “没看到反对”是否被错误写成“支持 / 共识”？
- Replies 是否保留 root / parent 语境？
- 需要理解触发原因时是否取得了正确上下文（Transcript 或 Frames）？
- 多来源是否先分开理解再融合？
- 重要结论能否回查？
- partial / sampling / missing 是否影响当前强词？
- 是否暴露不必要的用户标识？
