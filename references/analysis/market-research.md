# Market Research Analysis Protocol

> 适用 Intent：`market_research`
>
> 目标是从单个 B 站视频及其公开反馈中识别**可观察的商业信号、合理的机会假设和仍需验证的缺口**。
>
> 核心边界：**单视频不等于市场已验证。** 本协议不输出“市场需求已验证 / 值得做 / 用户一定愿意付费”这类强结论。

## 1. 什么时候进入 `market_research`

只有用户明确表达商业决策目标时才进入，例如：

- 市场 / 商业 / 需求；
- 痛点 / 未满足需求；
- 竞品 / 替代方案；
- 购买 / 付费 / 价格接受；
- 创业 / 机会；
- 目标用户怎么描述问题。

“对比”本身不触发 Market。

例如：

- “作者对比 Claude Code 和 Codex 时说了什么？” → `content_learn`
- “从用户反馈看 Claude Code 和 Codex 分别满足谁、谁更像替代品？” → `market_research`

评论里出现抱怨、建议或问题，也不会自动把 `audience_insight` 升级为 Market。

## 2. 市场语义角色：角色与证据层级分开

常见角色：

- `Pain`：用户遇到的痛苦 / 阻碍；
- `Job`：用户真正想完成的任务；
- `Scenario`：使用条件和场景；
- `Workaround`：当前替代做法；
- `Complaint`：抱怨；
- `Feature Request`：功能诉求；
- `Alternative`：替代方案；
- `Competitor`：竞品 / 竞争方案；
- `Objection`：阻碍购买或采用的质疑；
- `Purchase Intent`：购买 / 付费表达；
- `Action Intent`：试用、推荐、弃用等行动倾向；
- `User Language`：用户原始的表达方式；
- `Unmet Need`：未满足需求；
- `Opportunity Hypothesis`：机会假设。

### 不要把角色硬编码成“显式 / 推断”

同一个角色可能是直接表达，也可能是 Agent 根据上下文归纳。

例如评论：

> “我每天 Mac 和 Windows 来回切，文件全靠微信传，太麻烦了。”

可以得到：

- `Pain = 跨设备切换麻烦` → explicit；
- `Workaround = 微信传文件` → explicit；
- `Job = 跨设备同步工作文件` → inferred；
- `Scenario = Mac + Windows 双设备` → explicit / lightly inferred；
- `Unmet Need = 更自动的跨平台同步` → inferred。

因此每个重要 Signal 都应区分来源：

```text
role: Job
value: 跨设备同步工作文件
provenance: inferred
basis: rpid=...
```

`User Language` 必须尽量保留原始措辞，不用 Agent 改写后的术语冒充用户语言。

`Unmet Need` 和 `Opportunity Hypothesis` 永远属于推断层，必须给出依据链。

## 3. Focus-specific 阅读策略

### 3.1 `pain_discovery`

不要把所有负面评论都叫 Pain。

判断：

- 用户在什么 Job / Scenario 下受阻；
- 是一次情绪还是具体阻碍；
- 是否有多个独立 Evidence；
- 是否出现 Workaround / Counterexample；
- Pain 是否只在某版本、地区、设备或人群条件下成立。

### 3.2 `generic_purchase_intent`

关注：

- 明确愿意买 / 付费；
- 问价格、链接、什么时候上线；
- 因价格 / 条件而犹豫；
- 表达试用 / 推荐 / 弃用。

**购买表达 ≠ 真实购买行为。**

“问价格”是行动 / 购买信号，不等于已付费。

没有观察到 Purchase Intent 也不能写成“没人愿意买”。

### 3.3 `latest_purchase_intent`

只回答近期表达，明确当前 time sample 的时间范围。

不要把“最近没看到”推广成整个评论区历史都没有。

### 3.4 `competitor_landscape`

区分：

- 用户主动提到的 Competitor；
- 只是拿来类比的 Alternative；
- Workaround（用户自己拼的做法）；
- 作者介绍但用户没有采用信号的产品。

不要因为两个工具在同一视频出现就认定互为竞品。

### 3.5 `workaround_pattern`

重点恢复：

```text
Job
→ 为什么现有方案不够
→ 用户现在怎么凑合
→ Workaround 的成本 / 麻烦
```

Workaround 往往比单纯 Complaint 更能说明真实 Job。

### 3.6 `user_language`

目标是帮助用户理解“目标用户自己怎么描述问题”。

保留：

- 高频短语；
- 有辨识度的原始说法；
- 场景词；
- 用户表达的因果和情绪。

不要为了“专业”把所有原话改成产品经理术语。

### 3.7 `opportunity_hypothesis`

机会假设必须有推断链，例如：

```text
Pain
+ Job
+ Workaround / Competitor Gap
+ 可选的 Purchase / Action Signal
  ↓
Unmet Need
  ↓
Opportunity Hypothesis
```

不能从一条抱怨直接跳到“这是创业机会”。

输出应明确：

- 观察到了什么；
- 哪些部分是 Agent 推断；
- 当前信号强在哪里 / 弱在哪里；
- 下一步必须验证什么。

## 4. 跨源对齐

### 4.1 实时反应：Danmaku ↔ Transcript / Frames

弹幕和字幕共享视频时间轴，可用时间邻域理解即时反应。

但触发内容可能来自画面而不是口播：

- 口播触发 → Transcript；
- 视觉展示触发 → Frames；
- 两者共同 → 两种证据结合。

时间窗口是上下文启发，不是固定 5 秒算法；按视频节奏适当收缩或扩大。

### 4.2 评论 ↔ 作者方案

Comments 没有天然时间锚，依靠：

- 显式时间引用；
- 产品 / 功能 /术语；
- 语义上下文；
- 必要时 Transcript / Frames 作为作者方案锚点。

语义对齐是 Agent 判断，不要假装 Tool 已经完成。

### 4.3 独立评论之间

不同评论没有用户级关联时，只能说：

> “rpid=A 和 rpid=B 独立提到 X。”

不要写成：

> “用户 A 和 B 都认为 X”

除非确有回复关系或其它公开证据支持这种关联。

## 5. 信号强度：不要只看数量

可以综合：

- Frequency：独立证据数；
- Breadth：不同线程 / 时间 / 来源；
- Specificity：是否有具体场景；
- Workaround：是否已有真实替代行为；
- Purchase / Action Signal：是否出现明确行动表达；
- Counterexample：是否存在强反例；
- Sampling Bias：样本偏差；
- Ambiguity：需要多少猜测。

不需要计算固定总分。

稀疏但具体的 Workaround、Competitor、Purchase Intent 可能比大量泛泛点赞更有商业信息量。

## 6. Sampling / Saturation 只是成本控制，不是市场证明

可以根据评论区规模、Focus 和 Depth 渐进式翻页，但不要把阈值算法化。

例如连续几页新增信号变少，可以考虑停止，但必须同时问：

- 当前 Focus 是否属于稀疏信号（Purchase Intent / Competitor / Workaround）？
- 新页虽然只有一条新 Signal，是否信息量很高？
- hot / time 是否已经互补；
- selected replies 是否还有明显 Evidence Gap？

Saturation 只能说明：

> “继续取数的边际信息量开始下降。”

不能说明：

> “样本已经具有统计代表性 / 市场已经稳定。”

## 7. 量化与 Coverage

### 7.1 hot + time 必须去重

多排序、多页合并后按 rpid 去重，再做精确计数。

去重、计数、排序、Coverage 汇总属于确定性工作，不应让 Agent靠自然语言记忆完成。

### 7.2 不要滥用平台总评论数

平台报告的总量字段可能包含不同层级回复，不自动等于根评论总体。

除非字段语义已经确认，否则不要写：

> “抽了 80 / 88980 = 0.09% 根评论。”

更稳妥地报告：

> “取得 80 条去重根评论，来源为 hot 3 页 + time 1 页；平台另报告 total=N，但其统计口径不作为根评论分母。”

### 7.3 非概率样本不要写成总体比例

hot、time 连续样本、目的性 selected replies、hot+time 组合都不是概率抽样。

如果需要描述信号数量，可以写：

> “当前 89 条去重评论样本中，17 条明确提到跨平台问题。”

不要进一步写成：

> “19% 的用户有跨平台需求。”

### 7.4 Evidence Absence 不等于 Negative Evidence

**没看到 ≠ 不存在。**

- 没看到反对 ≠ 支持；
- 没看到问价格 ≠ 没购买意愿；
- 没看到抱怨 ≠ 没痛点；
- 没看到竞品 ≠ 没竞争。

只能写“当前样本未观察到”。

## 8. Grounding

### 8.1 可观察 Signal

每条重要 Signal 要能回查，例如：

```text
role: Pain
provenance: explicit
value: Windows 上无法使用
basis: rpid=123456
```

如果是 Agent 归纳：

```text
role: Job
provenance: inferred
value: 跨平台完成同一工作流
basis: rpid=123456 + rpid=234567
```

### 8.2 Unmet Need / Opportunity Hypothesis

必须列依据链：

```text
[推断] Unmet Need: 跨平台自动同步
  Pain: rpid=A/B
  Job: 从评论场景归纳
  Workaround: rpid=C “用网盘手动同步”
  作者方案边界: transcript 02:30-03:10 / frame F08
  结论: 当前证据支持“存在一个待验证的未满足需求假设”
```

没有依据链就不写。

## 9. 与其它 Intent 的协同

### Audience

同一评论可以在 Audience 中是 Complaint / Concern，在 Market 中进一步分析为 Pain / Objection 候选。

数据可复用，语义不能互相替代。

### Content

当市场判断依赖作者方案、功能边界、定价或主张时，用 Transcript 作为锚点。

### Visual

视觉不是 Market 默认数据，但当商业信号依赖屏幕上展示的：

- 产品界面；
- 价格；
- 对比表；
- 功能状态；

Frames 可以成为必要证据。

Visual 证据本身不能证明购买意愿。

## 10. 单视频边界

当前证据不能可靠支持：

- 市场规模 / TAM；
- 跨视频共识；
- 用户真实购买行为；
- 全网趋势；
- 跨平台 / 跨地域总体分布；
- “市场需求已验证”。

因此最终输出建议组织成：

1. **观察到的市场信号**；
2. **这些信号对应的 Job / Pain / Workaround / Competitor 等结构**；
3. **推断出的 Unmet Need / Opportunity Hypothesis**；
4. **证据强度与 Coverage**；
5. **下一步待验证项**。

这不是固定模板；用户问得很窄时只回答相关部分。

## 11. Tool 与 Agent 的边界

### 确定性层

Tool / helper 负责：

- 翻页；
- 排序；
- selected replies；
- 时间窗过滤；
- rpid 去重；
- 精确计数；
- Coverage 汇总。

### 语义层

Agent 负责：

- Pain / Job / Scenario / Workaround 等判断；
- provenance 是 explicit 还是 inferred；
- Unmet Need / Opportunity Hypothesis；
- 跨源语义对齐；
- 信号与用户商业问题的关系。

不要造 `get_pain_comments()` / `get_opportunity()` 这类语义 Tool。

## 12. 输出前自检

- 用户是否真的有明确商业目标？
- 每个重要 Signal 是否能回查？
- Role 与 provenance 是否分开？
- Unmet Need / Opportunity 是否有推断链？
- 评论表达是否被误写成真实购买行为？
- “没看到”是否被误写成“不存在 / 支持”？
- hot + time 是否去重？
- 是否把平台总评论数误当根评论分母？
- 非概率样本是否错误输出“用户比例”？
- Saturation 是否被误写成代表性证明？
- 单视频是否被错误升级为“市场已验证 / 值得做”？
- 必要的作者方案 / 画面上下文是否已补齐？
