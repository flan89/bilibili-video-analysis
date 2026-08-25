# Content Learn Analysis Protocol

> 适用 Intent：`content_learn`
>
> 目标不是把 Transcript 压缩成摘要，而是帮助 Agent **判断视频在说什么、什么重要、为什么重要、哪些只是例子或铺垫，以及用户当前问题真正需要哪一部分**。

最终输出结构服从用户目标，不使用固定报告模板。

## 1. 把 Transcript 看成不同语义功能

Transcript 是连续口语，不是已经整理好的文章。阅读时可用以下角色理解内容功能：

| 角色 | 含义 |
|---|---|
| `Claim` | 作者明确提出的观点或判断 |
| `Reason` | 为什么 Claim 成立 |
| `Evidence` | 作者用于支持 Claim 的事实、数据、经验或观察 |
| `Example` | 案例、演示、类比、对比 |
| `Method` | 可复用的方法、框架或做法 |
| `Action` | 具体操作动作 |
| `Condition` | 前置条件、适用范围、成立条件 |
| `Caveat` | 限制、风险、保留意见、例外 |
| `Definition` | 概念或术语解释 |
| `Transition` | 话题连接或结构过渡 |
| `Filler` | 寒暄、重复、无实质推进内容 |

这些角色是阅读框架，不要求机械给每句话贴标签。

## 2. 判断“核心”不要只看频率

一个内容更可能是核心信息，当它同时具有若干信号：

- 直接回答视频的中心问题；
- 作者明确表态；
- 被展开解释；
- 有 Reason / Evidence / Example 支持；
- 后续内容继续依赖它；
- 在不同位置重新强调；
- 对理解后续方法或结论具有结构性作用。

重复只是一个信号。口头禅、广告语和过渡也可能高频。

## 3. 区分四个认识层级

### 3.1 作者明确表达

字幕中能直接找到对应 Claim / Reason / Condition / Caveat。

### 3.2 Agent 归纳

作者没有一句话完整说出，但多段内容共同支持一个结构化总结。

允许归纳，但不要写成作者原话。

### 3.3 Agent 推断

从作者内容进一步延伸出的解释、迁移或建议。

可以有价值，但必须让用户知道这是分析。

### 3.4 外部事实验证

**作者提供的 Evidence 不等于事实已经被外部验证。**

例如作者引用一个数字、医学结论、产品性能或市场数据，当前 Skill 可以判断：

- 作者是否真的提出了这个证据；
- 这个证据在视频内部支撑哪个 Claim；
- 论证链是否完整；

但如果用户问：

- “这个说法是真的吗？”
- “医学上靠谱吗？”
- “这个市场数据准确吗？”
- “技术事实有没有依据？”

而当前只有视频内部材料，就只能评价**视频内部论证**，不能把 Author-provided Evidence 写成 externally verified fact。

如果另有外部来源，可单独做事实核验，并明确区分“视频怎么说”和“外部资料是否支持”。

### 3.5 平台生成字幕与 ASR 的引用纪律

`official_ai`（平台生成字幕）和 `asr`（本地语音识别）的文本可能出现识别错误。Agent 可以结合上下文理解明显错词，但不能把静默修正后的句子放进引号，伪装成 Tool 返回的原文。

- 直接引用必须与 Transcript 文本一致；
- 需要修正明显错词时，优先改为转述，并说明“按上下文理解”；
- 确实需要保留引号时，明确标注校正，例如“（按上下文校正了产品名）”，并在重要场景保留原始识别文本供回查；
- 人名、产品名、数字、法律条文、医学结论等关键实体不能只靠上下文静默修正。无法用视频其它位置或外部可靠来源核实时，降低表述强度并公开不确定性；
- `official` 也不是外部事实保证，但它至少是作者提供的文本；事实核验仍遵守 §3.4。

## 4. Focus-specific 阅读策略

### 4.1 `core_ideas`

目标不是缩短全文，而是恢复主要思想结构：

1. 视频主要在回答什么问题；
2. 直接回答问题的 Claim；
3. 支撑 Claim 的主要 Reason；
4. Example 与真正核心观点的区别；
5. Condition / Caveat；
6. 合并语义重复观点，但保留不同理由。

优先输出少量高中心性观点，而不是罗列所有信息点。

### 4.2 `high_value_knowledge`

“有价值”不等于“视频里出现过”。综合考虑：

- `Relevant`：和用户当前目标相关吗；
- `Non-obvious`：是否超出表面常识；
- `Actionable`：能否指导判断或行动；
- `Supported`：视频是否真正展开支持；
- `Transferable`：能否迁移到相似问题；
- `Leverage`：理解这一点是否能解释多个后续细节。

对寒暄、无关闲聊、重复铺垫、一次性未展开提及、宣传性表达和偶然案例细节降权。

如果视频本身几乎没有知识型内容，可以直接说明，不要为了满足“提炼知识”而从 Agent 自身知识里补一条出来。

### 4.3 `viewpoint_curation`

判断主张强度时观察：

- 是否是明确判断，而非假设、玩笑或举例；
- 是否被重复强调；
- 是否有 Reason；
- 是否有 Evidence / Example；
- 后续是否继续建立在该判断上；
- 是否有 Condition / Caveat；
- 是否只是过渡、类比、夸张或情绪表达。

可以理解为连续强度：

```text
随口提及 → 倾向判断 → 明确观点 → 被充分展开的核心主张
```

不要仅凭语气强硬就判断为核心观点。

### 4.4 `argument_structure` / `evidence_reasoning`

尽量恢复：

```text
Question
  ↓
Claim
  ↓
Reason(s)
  ↓
Author-provided Evidence / Example
  ↓
Condition / Caveat
```

注意：

- Example 不等于 Evidence；
- 个人经验可以是作者依据，但不能自动泛化成普遍事实；
- 强判断没有充分理由时直接说明“视频没有展开充分论证”；
- “有 Evidence”不等于外部事实已验证。

### 4.5 `tutorial_steps` / `workflow`

恢复真实动作链：

```text
Prerequisite
  ↓
Action
  ↓
Expected Result
  ↓
Validation
  ↓
Failure / Caveat
  ↓
Next Action
```

区分：

- 字幕明确说明的动作；
- 字幕明确说明的结果；
- 依赖画面才能确认的 UI / 参数 / 状态；
- 作者口头跳过但可能存在的步骤。

最后一种不能自行补齐。关键操作依赖画面时回到 Data Routing，按需补 Frames。

### 4.6 `methods` / `actionable_takeaways`

恢复：

- 方法解决什么问题；
- 核心做法；
- 前置条件；
- 为什么有效；
- 适用场景；
- 限制 / 成本；
- 视频案例；
- 用户可以尝试的下一步。

区分作者建议与 Agent 整理出的行动建议。

### 4.7 `tool_scenario_mapping`

当视频比较多个工具 / 产品 / 方案时，优先恢复：

```text
Tool / Approach
  → 解决什么 Job
  → 适合什么 Scenario
  → 为什么适合
  → 不适合 / 限制
  → 与其它方案的关键差异
```

如果用户问“全部工具”，Coverage 必须覆盖视频里所有相关工具，而不是只列 Agent 熟悉的几个。

### 4.8 `key_concepts` / `concept_relationships`

恢复：

```text
Concept
  → Definition
  → Why it matters
  → Relationship
  → Mechanism / Reason
  → Example
  → Boundary
```

不要把孤立术语定义误当成完整知识结构。

### 4.9 `case_studies`

说明案例在论述中的用途：

- 证明观点；
- 解释概念；
- 展示方法；
- 还是顺带举例。

尽量恢复情境、动作、结果、作者得到的结论，以及这个结论能否泛化。

### 4.10 `targeted_question:*`

不要先做全片总结。

1. 明确问题中的实体、条件和范围；
2. 定位相关 Transcript；
3. 找直接回答；
4. 找条件、理由、例外；
5. 判断视频是否真的提供足够依据；
6. 先回答问题，再补必要上下文。

字幕没有答案就明确说明，不用常识替代视频答案。

## 5. 多 Focus 组合

Primary Focus 决定主结构，Secondary Focus 只补用户明确需要的维度。

例如：

```text
core_ideas
  ↓
找核心 Claim / Reason
  ↓
actionable_takeaways
  ↓
筛出可执行方法、条件和限制
```

不要为每个 Focus 生成互不相干的小报告。

## 6. 长视频与 Coverage

用户要求全片时：

- 输入必须覆盖全片；
- 技术性分页不等于语义章节；
- 分页分析要保留跨页观点关系；
- 合并时检查后半段的新观点、工具、条件和 Caveat。

无法完整处理时明确限制，不声称已覆盖全片。

## 7. 输出前自检

- 我是在回答用户问题，还是在复述视频？
- “核心”是否真的有中心性或展开支持？
- 是否把 Example 当成 Claim？
- 是否把 Agent 归纳写成作者原话？
- 是否遗漏 Condition / Caveat？
- Author-provided Evidence 是否被误写成 externally verified fact？
- 用户要求“所有 / 完整”时是否真的覆盖？
- 重要结论能否回到时间范围？
- Transcript 来源和完整性是否可能改变结论？
