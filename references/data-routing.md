# Data Routing：把认知任务映射成最小证据计划

Task Routing 已经回答“用户想完成什么”。这里回答：

> **为了可靠完成这个 Intent / Focus，最少需要什么证据？**

不要从“有哪些 Tool”反推用户任务，也不要把 Optional Data 当成默认套餐。

## 1. 数据计划语义

- `required`：缺失后无法可靠完成当前目标；
- `optional`：可能提高质量，但默认不获取；
- `avoid_by_default`：当前目标下通常不应获取；
- `fallbacks`：Required Data 缺失时才考虑的替代路径。

Data Plan 同时考虑：Intent、Focus、Depth、用户指定范围、数据成本与 Coverage。

## 2. 单视频基础数据矩阵

| 数据 | content_learn | visual_decode | audience_insight | market_research | overview |
|---|---|---|---|---|---|
| metadata | O | O / Focus | O | O | O |
| transcript | R | O / Focus | O / Focus | O / Focus | O / R |
| frames | O / Focus | R / Focus | O / Focus | O / Focus | O |
| danmaku | - | - | R / Focus | O / Focus | O |
| comments | - | - | R / Focus | R / Focus | O |
| replies | - | - | O / Focus / Depth | O / Focus / Depth | - |

这只是默认矩阵；具体 Focus 可以调整 Required / Optional。

`topic_research` 是先发现候选、再分析选中视频的两阶段规划，不在此矩阵中，见 §7。

## 3. `content_learn`

默认：

- Required：`transcript`
- Optional：`metadata`
- Avoid by default：comments、danmaku、replies、frames

### 什么时候需要 Metadata

只有当用户实际问到：

- 标题 / 简介 / 作者 / 发布时间 / 标签 /统计；
- 分P背景；
- 标题、简介与正文是否一致。

普通内容总结、知识提炼、观点梳理、教程、定向问答不应为了“更完整”额外调用 Metadata。

### 什么时候需要 Frames

教程或内容问题只有在关键事实依赖画面时才补 Frames，例如：

- GUI 状态；
- 屏幕上的工具名 / 参数；
- 图示 / 表格；
- 作者只展示、没有口播的重要信息。

不要因为“教程”两个字默认下载视频。

### Transcript fallback

```text
官方字幕可用
→ 使用官方字幕

官方字幕 missing 且 Transcript 仍 Required
→ ASR fallback
```

ASR 仍无法取得可靠 Transcript 时，明确 Capability Gap，不用标题 / 简介猜正文。

## 4. `visual_decode`

视觉数据由 Focus 决定：

- `cover` → metadata cover URL；
- `overall_visual_style / ppt_layout / typography / information_density / subtitle_style` → representative frames；
- `editing_rhythm / visual_change_pattern` → scene visualChanges + representative frames；
- `targeted_visual_question` → timestamp / 邻域 frames；
- `content_visual_alignment` → frames + transcript。

默认不要 comments / danmaku。

注意：Frames 也可以作为其它 Intent 的辅助证据。是否需要 Frames 取决于**问题是否依赖画面**，不是取决于“当前 Intent 是否叫 visual_decode”。

## 5. `audience_insight`

按 Focus 选择观众来源：

### 评论讨论

`discussion_topics / controversy / repeated_questions / shared_concerns / audience_segments / same_problem_validation`

通常：

- Required：comments
- Optional：selected replies
- Optional：transcript / frames（当需要解释评论所指的作者表达或画面）

### 即时反应

`resonance / danmaku_peaks / high_engagement_segments`

通常：

- Required：danmaku
- Optional：transcript
- Optional：frames

解释“为什么这个时间点反应突然增强”时，先判断触发信息来自：

- 口播 → transcript；
- 画面 → frames；
- 两者都有 → 按最小必要组合补证据。

### 跨渠道一致性

`cross_channel_consistency`

通常：

- Required：comments + danmaku
- Optional：transcript / frames（只用于解释两类反应为什么不同）

### Replies 什么时候升级为 Required

当用户问题依赖：

- 争议双方理由；
- “是不是多人遇到同一问题”；
- 某条高价值评论的条件 / 反例；
- 根评论信息不足以判断语义。

否则不要默认抓完整回复树。

## 6. `market_research`

只有 Task Routing 已明确进入 `market_research`，才规划市场证据。

市场研究不是“更多数据”，而是**在明确商业问题下重新解释相关证据**。

### 6.1 常见 Focus

#### `pain_discovery`

- Required：comments（建议 hot + time 互补样本并按 rpid 去重）
- Optional：selected replies
- Optional：transcript（需要理解作者方案 / 产品边界时）

#### `generic_purchase_intent`

用户问“有没有购买 / 付费意愿”而不是“最近”：

- Required：comments，hot + time 双向样本更稳妥
- Optional：selected replies

稀疏 Purchase Intent 不能因为最近一页没出现就判定“不存在”。

#### `latest_purchase_intent`

用户明确问“最近 / 现在”：

- Required：comments `sort=time`
- Optional：hot sample 作为背景对照

#### `competitor_landscape`

- Required：comments
- Optional：transcript（确认评论提到的方案与视频中作者方案的关系）
- Optional：selected replies

#### `workaround_pattern`

- Required：comments
- Optional / Focus：selected replies

#### `user_language`

- Required：comments
- Optional：selected replies

目标是保留用户原始表达，不把 Agent 改写后的术语当 User Language。

#### `opportunity_hypothesis`

- Required：comments
- Optional：selected replies
- Transcript 只有当作者方案 / 产品边界构成推断链关键锚点时才 Required
- Danmaku 只有即时反应对当前假设真正有信息增益时才 Optional

**推断复杂不等于所有数据都 Required。**

### 6.2 跨源 Focus

#### `realtime_reaction_alignment`

- Required：transcript + danmaku
- Frames：当触发内容主要来自画面时 Optional / Required

#### `creator_feedback_alignment`

- Required：transcript + comments
- Optional：selected replies
- Frames：作者方案主要靠画面展示时 Optional / Required

#### `full_cross_source`

- Required：transcript + danmaku + comments
- Replies / Frames：仍按 Evidence Gap 决定，不默认全取

不要再用一个模糊 `cross_source_alignment` 强制所有来源。

### 6.3 确定性数据准备与语义分析分工

确定性工作优先由 Tool / helper 完成：

- 分页；
- hot / time 样本按 rpid 去重；
- 精确计数；
- 排序；
- Coverage 汇总；
- 时间窗过滤。

Agent 负责：

- Pain / Job / Scenario / Workaround 等语义角色；
- Unmet Need / Opportunity Hypothesis 推断；
- 跨源语义对齐；
- 判断哪些信号对用户商业问题真正有意义。

不要造 `get_pain_comments()` 之类语义 Tool，也不要让 Agent 承担容易出错的精确去重 / 计数。

### 6.4 抽样与 Saturation

评论区大小只能作为成本启发，不是代表性证明。

渐进式翻页可以在“新增信息明显下降”时停止，但：

- Saturation 是成本控制启发式，不是统计完整性的证明；
- 稀疏但高价值的 Competitor / Purchase Intent / Workaround 信号不能只按数量阈值忽略；
- `complete=false` 必须保留；
- 平台报告的评论总量字段不自动等于根评论总体，不能直接用作采样率分母。

### 6.5 单视频市场边界

单视频可以输出：

- 可观察市场信号；
- 信号强弱与证据；
- Unmet Need / Opportunity Hypothesis；
- 下一步需要验证什么。

不能输出：

- 市场需求已验证；
- 用户真实愿意付费；
- 市场规模 / TAM；
- “值得做 / 应该创业”这类已验证式强结论。

## 7. `topic_research`：两阶段数据规划

`topic_research` 不适合放进上面的单视频矩阵，因为它天然分两个阶段：

```text
阶段一：发现候选
  Required：按用户目标选择发现来源（见 7.1 来源表）

阶段二：分析选中视频
  Required / Optional：由用户 Focus 决定（回到单视频矩阵）
```

### 7.1 阶段一：发现候选

根据用户目标选择 Required 发现来源（来源选择优先于调用 Tool，见 [`discovery-strategy.md`](discovery-strategy.md) §0）：

| 用户目标 | Required | 后续按 Focus 可选 |
|---|---|---|
| 关键词找视频 | `video_candidates` | Transcript / Comments / Frames 等 |
| 查看当前热门 | `popular_video_candidates` | 用户要求分析内容时才取正文证据 |
| 查看当前热搜 | `hot_search_topics` | 用户要求研究某词时再取 `video_candidates` |
| 从视频找相关内容 | `related_video_candidates` | 选中后按 Focus 获取正文证据；需要覆盖主题时可补 `video_candidates` |
| 当前排行榜 | 暂无可用数据，报告 `ranking_snapshot` 能力缺口 | 不用热门或搜索冒充 |

发现来源的通用规则：

- 用户只给主题或问题时，默认仍以关键词搜索（`video_candidates`）为入口；候选明显不足或偏离目标时才按发现策略补充变体；
- 发现阶段的深度由 Depth 决定：`quick` 只看一页候选或一组快照；`standard` / `deep` 默认总共查看约 20～40 条候选元信息；
- 来源为空、失败或遭遇风控时，按 Tool 的 `acquisition.status` 结构化降级，不编造候选；
- 单来源失败时不用其它来源静默冒充（用户要热门而热门失败 → 公开失败，不拿搜索结果假装热门）；
- 具体搜索词设计、候选选择和停止条件见 [`references/discovery-strategy.md`](discovery-strategy.md)。

### 7.2 阶段二：分析选中视频

选中 3～5 个视频后，每个视频的数据需求回到单视频矩阵，按 Focus 决定：

- 主题内容研究（方法比较、共识 / 分歧、各自经验）通常 Required：`transcript`；
- 评论、回复、弹幕和 Frames 仍按 Focus 决定，**不因“跨视频”自动升级为 Required**；
- 用户问观众反应 → 只对选中且必要的视频获取评论 / 弹幕；用户问画面 → 只在画面证据确实必要时获取 Frames；
- Metadata 通常 Optional，只在需要确认发布时间、作者独立性或标签时获取。

### 7.3 跨视频 Coverage

当前 `TaskPlan` 可以表达所需数据类别，不为 topic_research 新建程序化多阶段编排器。具体每个视频实际取得了哪些数据来源，由 Agent 在上下文中维护，并在最终 Coverage 中说明：

- 每个选中视频实际取得了哪些数据；
- 哪些视频存在无字幕、自动转写、评论不完整或其它缺口；
- 数据缺失的视频不能与证据完整的视频等强度比较。

## 8. `overview`

Overview 是轻量 preset，不是默认全分析。

通常从以下数据中选最小组合：

- metadata；
- transcript；
- 少量 frames；
- 少量 comments。

默认不要：

- 完整 comments / replies；
- 全量 danmaku；
- 重型视觉下载；
- 自动进入 `market_research`。

Overview 的目的通常是“先知道视频大致是什么，再决定是否深挖”。

## 9. Evidence Gap 与 Fallback

分析过程中允许回到 Data Routing，但每次只补当前结论缺少的最小证据。

典型：

```text
Audience: 弹幕峰值无法解释
→ 判断触发来自口播还是画面
→ 补 transcript 或 frames
```

```text
Market: 评论说“这个太贵”但不知道指哪个方案
→ 补 transcript / frame 确认上下文
```

```text
Tutorial: 字幕描述“点这里”但没有按钮信息
→ 补目标时间附近 frames
```

不要因为发生一次 Evidence Gap 就顺便抓所有数据源。

## 10. Coverage 与成本优先级

成本优化只能改变：

- Optional Data；
- 分页规模；
- 抽样方式；
- selected replies 深度；
- quick / standard / deep 的执行规模。

不能改变：

- 用户明确要求的范围；
- Required Data 的必要 Coverage；
- “全片 / 所有 / 完整”等承诺。

## 11. 多 Intent 组合

多 Intent 时：

1. 各自确定 Focus；
2. Required Data 求并集；
3. 同一数据只获取一次；
4. Optional Data 仍按最小原则；
5. 各 Intent 按自己的 Analysis Protocol 解读共享数据；
6. 最后只在证据允许时综合。

核心原则：

> **Shared Data + Separated Semantics**

例如同一评论“Windows 不能用”：

- audience_insight 可判断为 Concern / Question；
- market_research 可在足够上下文下判断为 Pain 候选；
- 数据不必获取两次，但语义判断不能互相替代。

某项 Required Data 失败时,只降级依赖该数据的结论;其它有充分证据支撑的部分继续。不要让一个失败数据源自动拖垮整个多 Intent 请求。
