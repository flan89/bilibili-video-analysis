# Task Routing：先判断用户真正要完成什么

Task Routing 是整个 Skill 的第一层认知路由。它回答的是：

> **这次任务是什么、具体关注什么、需要多深，以及是否必须先澄清？**

它不是 Tool 选择表。数据获取属于下一层 `data-routing.md`。

普通用户任务中不必输出 TaskPlan JSON；这些字段主要帮助 Agent 保持内部思路稳定，也用于路由回归评测。

## 1. 路由顺序

按以下顺序理解任务：

1. `objective`：保留用户自然语言目标，不先改写成系统模板；
2. `primary_intent`：判断最主要的认知任务；
3. `secondary_intents`：只有确实改善答案时才增加；
4. `focus`：描述这次具体要观察、提取或判断什么；
5. `depth`：选择 `quick`、`standard`、`deep`；
6. `clarification`：判断是否必须先问一个问题；
7. 完成以上步骤后，再进入 Data Routing。

Focus 是开放集合。测试中的 Focus 只是示例，不是白名单。

---

## 2. Intent

### `content_learn`

用户想理解、学习或回答视频正文中的内容。

典型目标：

- 总结核心内容；
- 提炼真正有价值的知识；
- 判断哪些是核心观点、哪些只是随口表达；
- 理解观点与理由；
- 梳理概念和关系；
- 提取方法、流程、教程步骤；
- 提取工具、案例及适用场景；
- 制作学习笔记；
- 围绕某个指定主题或问题查找视频中的答案。

常见 Focus 示例：

`core_ideas`、`high_value_knowledge`、`viewpoint_curation`、`argument_structure`、`evidence_reasoning`、`tutorial_steps`、`workflow`、`methods`、`tool_scenario_mapping`、`case_studies`、`key_concepts`、`concept_relationships`、`actionable_takeaways`、`topic_focus:*`、`targeted_question:*`。

重要边界：

- “有没有我可能不知道的”理解为找相对非显而易见、值得注意的信息；不查询用户长期知识历史；
- “教程”首先是认知任务，不等于必须抓视频画面；是否需要视觉证据在 Data Routing 决定。

---

### `visual_decode`

用户主要想理解视频是**怎么做出来、怎么呈现信息**的。

典型目标：

- 封面；
- PPT / 排版 / 字体 / 字幕视觉；
- 构图 / 留白 / 配色；
- 镜头变化；
- 剪辑节奏；
- B-roll / 录屏；
- 信息密度；
- 说话节奏与整体呈现关系。

常见 Focus 示例：

`cover`、`overall_visual_style`、`ppt_layout`、`visual_hierarchy`、`typography`、`subtitle_style`、`information_density`、`screen_recording`、`editing_rhythm`、`shot_change`、`broll_usage`、`visual_emphasis`、`content_visual_alignment`、`targeted_visual_question`。

不要因为视频“看起来不错”就自动把内容学习升级成视觉拆解。

视觉 Focus 的 Frame Plan 跟 mode 选型见 [`references/analysis/visual-decode.md` §4](analysis/visual-decode.md#4-14-focus-的阅读策略)。`cover` 走 metadata URL, 不调 frames Tool。

---

### `audience_insight`

用户想理解观众公开反馈中体现出的关注、问题、共鸣和分歧。

典型目标：

- 评论区主要讨论什么；
- 哪些地方共鸣强；
- 哪些内容没听懂；
- 高频问题；
- 争议、支持与反对；
- 弹幕峰值和即时反应；
- 评论与弹幕是否一致；
- 按需求、行为、关注点或使用场景进行窄范围分群。

常见 Focus 示例：

`discussion_topics`、`resonance`、`confusion`、`repeated_questions`、`controversy`、`opinion_distribution`、`consensus`、`high_engagement_segments`、`danmaku_peaks`、`cross_channel_consistency`、`audience_segments`、`shared_concerns`、`same_problem_validation`。

不要从公开评论推断没有证据支持的人口统计属性。

---

### `market_research`

只有用户明确表达产品、需求、竞品、付费、机会、商业等目标时才进入。

典型目标：

- Pain / Job / Scenario；
- Workaround / Friction / Complaint；
- Feature Request / Unmet Need；
- Alternative / Competitor；
- Objection；
- Purchase / Action Intent；
- Opportunity Hypothesis；
- User Language。

常见 Focus 示例：

`pain_discovery`、`job`、`scenario`、`workaround_pattern`、`complaint`、`feature_request`、`unmet_need`、`competitor_landscape`、`alternative`、`objection`、`generic_purchase_intent`、`latest_purchase_intent`、`action_intent`、`opportunity_hypothesis`、`user_language`、`realtime_reaction_alignment`、`creator_feedback_alignment`、`full_cross_source`。

强制边界：

- 单条抱怨 ≠ 已验证需求；
- 问价格/链接/上线时间 = 行动或购买信号，不等于真实付费；
- 单个视频最多形成机会假设，不证明市场成立。

---

### `topic_research`

用户没有提供具体视频，而是给出主题、问题或品类，需要先在B站发现合适的视频，再进行研究；或者用户想直接了解平台当前的发现信号（当前热门等）。

典型目标：

- 研究B站上关于某个主题的内容（共同强调的方法、主要分歧、各自独有经验）；
- 从主题出发寻找并比较多个视频；
- 只想找几个值得看的视频；
- 比较同一主题下的不同方法或流派；
- 围绕某个问题收集多个视频中的答案；
- 查看B站当前热门里有哪些值得关注的内容；
- 从一个具体视频继续发现相关但侧重点不同的内容。

常见 Focus 示例：

`method_comparison`、`shared_consensus`、`key_disagreements`、`complementary_insights`、`representative_sampling`、`topic_landscape`、`trend_snapshot`、`quick_recommendation`、`popular_snapshot`、`hot_search_snapshot`、`related_recommendation`。

判定边界：

- **没有视频、需要先发现内容 → `topic_research`**；用户给了一个具体视频问“里面关于 X 讲了什么”，是 `content_learn` 的定向问题，不是 `topic_research`；
- **用户给了具体视频，但目标是“找类似、找相关、继续发现”→ `topic_research`**：不能因为存在视频链接就误判为 `content_learn`；此时按发现策略用关联推荐（`related-videos`）展开，并表述推荐邻接关系边界；用户给定视频且问题针对该视频正文时，仍走单视频流程，不误触发关联推荐；
- **用户询问当前热门 → `topic_research + quick`**：可以直接用一页热门快照回答，不自动深入分析全部条目；
- **比较分析不单独成为 Intent**：比较多个视频 = `topic_research`；比较同一视频里弹幕与评论 = `audience_insight` 的跨渠道 Focus；
- **“只想找几个相关视频”** 是 `topic_research + quick`，搜索并解释候选即可，不自动深入分析；
- **明确商业目标 + 需要跨视频发现**：按用户最终目标决定 `market_research` 与 `topic_research` 的主次组合，商业结论仍受 `market_research` 边界约束；
- **趋势只是开放 Focus**：出现“最近”“热门”不自动承诺历史趋势能力；用户询问某主题是否持续升温时，仍报告历史数据缺口，不能用一次热门或搜索快照冒充趋势；
- **用户明确要求排行榜**：当前 Skill 没有排行榜 Tool，数据规划必须报告能力缺口，**不能用当前热门替代排行榜**，也不能偷偷改成普通关键词搜索冒充；
- **用户要求热搜** → `topic_research + quick`：直接用一组热搜词条快照回答，如实列出词条与商业标记，不编造事件背景；用户要求研究某个词时，才按发现策略展开"热搜词 → `search-videos`"两步流程；用户自带热搜词进来而会话中没有近期热搜快照时，先取一组热搜核对词条与商业标记，再进入搜索；

---

### `overview`

用户目标很宽泛，但低成本浏览可以先产生价值或帮助决定下一步时使用。

适合：

- “帮我看看这个视频”；
- “这个视频感觉挺有东西，帮我拆一下”；
- 用户尚未指定具体 Focus，但轻量了解不会触发明显重型路径。

`overview` 是路由 preset，不应成为“默认全分析”。

如果宽泛表达同时可能指向两种明显不同的重型任务，优先澄清。例如：

> “这个视频不错，看看有什么值得我学习和借鉴的地方。”

可能是学内容，也可能是学制作方式；如果两者的数据路径明显不同，应问一次主要想借鉴哪一方面。

---

## 3. Primary / Secondary Intent

大多数任务只需要一个 Primary Intent。

只有当第二种 Intent 对回答有明确贡献时才增加 Secondary Intent。例如：

> “先总结作者的方法，再看看评论区大家实际使用后有什么问题。”

可以是：

- Primary: `content_learn`
- Secondary: `audience_insight`

不要为了“完整”机械加入多个 Intent。

---

## 4. Focus：真正决定分析方式的变量

Intent 只给出稳定的大方向；Focus 描述本次具体问题。

同样是 `content_learn`：

- `core_ideas` 关注中心观点；
- `high_value_knowledge` 关注非显而易见且可迁移的信息；
- `viewpoint_curation` 关注观点强度与“认真主张 vs 随口表达”；
- `tutorial_steps` 关注动作链；
- `tool_scenario_mapping` 关注工具与适用场景；
- `targeted_question:*` 只围绕指定问题找答案。

因此 Focus 不只是选择数据，也应选择后续分析协议中的阅读策略。

---

## 5. Depth

### `quick`

用于：

- 范围很窄的 Focus；
- 快速判断是否值得继续；
- 低成本 overview。

特点：只获取最小证据，不主动扩张范围。

### `standard`

目标明确的普通任务默认使用。

### `deep`

用于：

- 用户明确要求深挖；
- 需要更多来源交叉支持；
- 需要代表性抽样或较完整线程；
- 需要跨弹幕、评论、正文或视觉比较。

Depth 影响数据规模和分析深度，但不能突破 Intent 边界，也不能把 Required Coverage 降级成局部覆盖。

---

## 6. Clarification

只有同时满足以下条件时才澄清：

1. 至少存在两个合理解释；
2. 它们会导致明显不同的数据需求或分析方式；
3. 低成本 overview 不能同时很好地满足两者。

不必澄清：

- 有明显主 Intent；
- 不确定性只影响 Optional Data；
- 可以先做轻量步骤而不浪费明显成本。

澄清问题应短，只解决当前分叉，不询问大范围个人背景。

---

## 7. 路由完成后的输出

Task Routing 的结果进入 `data-routing.md`：

```text
objective + intent + focus + depth
              ↓
          Data Routing
```

不要在 Task Routing 阶段让当前 Tool Availability 反向修改用户真实任务。能力限制、fallback 和证据缺口由 Data Routing 处理。
