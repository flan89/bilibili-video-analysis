# Visual Decode Analysis Protocol

> 适用 Intent：`visual_decode`
>
> 目标是理解**视频如何呈现信息、视觉结构如何变化、哪些视觉做法可能影响理解与观看体验**。不做无依据的审美打分，也不把静态采样伪装成完整视频观察。

## 1. 先区分三层：观察、解释、建议

视觉分析最容易把“看到了什么”和“为什么这样设计”混在一起。

### Observation

Frame 上直接可见的事实，例如：

- 白底黑字；
- 标题位于左上；
- 当前页有三组信息；
- 字幕位于底部；
- 05:20 与 05:25 画面发生明显变化。

### Interpretation

Agent 对视觉作用的解释，例如：

- 可能降低信息竞争；
- 可能强化层级；
- 可能让观众更容易定位重点。

这些不是 Frame 上直接存在的事实，要用“可能 / 在当前上下文中起到”之类措辞。

### Recommendation

用户明确想学习 / 借鉴时，才给可迁移建议。

不要把 Recommendation 写成普适设计定律。

## 2. 视觉证据天然有 Coverage 边界

### Frames

代表帧适合判断：

- 布局；
- 排版；
- 色彩；
- PPT / UI / 真人 / B-roll 等呈现形式；
- 当前采样中的视觉层级和信息密度。

看到几张 Frame ≠ 看完整视频。

### visualChanges

Scene mode 的 visualChanges 是 **ffmpeg 检测到的视觉变化候选时间点**。

它适合：

- 比较变化密集 / 稀疏区间；
- 发现长时间静态区；
- 为进一步抽 Frame 提供候选位置。

它不等于：

- 精确 Shot Detection；
- PPT 切页分类；
- B-roll 分类；
- 导演意义上的镜头数。

除非 Tool 明确报告 truncation，否则按 Tool reference 的 Coverage 解释；任何截断 / partial 都必须进入结论边界。

### 静态帧无法可靠判断

- 转场动画；
- zoom / 镜头运动；
- 动态特效全过程；
- 音画卡点；
- PPT 内部元素动画。

遇到这些问题直接声明 Capability Gap。

## 3. 视觉阅读维度

按 Focus 选择，不要求每帧全扫。

### Structure

- Layout
- Hierarchy
- Alignment
- Whitespace
- Density
- Grouping

### Typography

- 标题 / 正文 / 注释层级
- Size contrast
- Weight
- Line length
- Subtitle typography
- Emphasis

### Color

- Primary palette
- Contrast
- Accent
- Semantic color usage
- Background

### Presentation

- PPT
- Screen recording
- Talking head
- B-roll
- UI demo
- Code
- Diagram

### Temporal Pattern

- Visual change density
- Static intervals
- Scene-change candidate distribution
- 代表帧中观察到的 PPT / B-roll / UI 变化

### Cross-source Context

必要时结合 Transcript、Comments、Danmaku，但视觉协议只负责视觉相关判断。

## 4. Focus-specific 阅读策略

### 4.1 `overall_visual_style`

需要覆盖全片不同时间段的代表帧，而不是只看开头连续若干帧。

关注跨帧稳定出现的：背景、布局模板、字体体系、色彩、呈现形式。

结论写成：

> “当前覆盖 0:00 / 05:00 / 10:00 / 15:00 等代表位置的帧中，持续出现……”

而不是单帧推成“整个视频”。

### 4.2 `ppt_layout`

关注：Layout / Hierarchy / Whitespace / Density / Grouping。

Scene-change candidate 可能是 PPT 切页，也可能是同页动画或其它画面变化；只有实际读到 Frame 后才能分类。

### 4.3 `visual_hierarchy`

比较信息最满和最空的代表帧，观察标题、正文、注释、高亮之间的权重关系。

### 4.4 `typography`

观察字体层级、字号对比、字重、行宽、可读性。

任何数字（例如“标题约为正文 2 倍”“一行多少字”）都只是**观察提示**，不是通用质量阈值。视频目标、分辨率、观看设备和内容类型优先。

小字看不清时报告 Capability Gap，不猜文字。

### 4.5 `subtitle_style`

分析位置、颜色、描边 / 背景、字号、双语形式等视觉属性。

Transcript 文本不是视觉字幕样式证据。

### 4.6 `information_density`

比较多个时间点的信息量和组织方式。

不要仅凭一张密集 PPT 判断整个视频“信息量很大”。

### 4.7 `screen_recording`

观察鼠标 / 标注 / 工具栏 / UI 切换 / 步骤分段。

连续操作流程如果仅靠静态帧无法恢复，明确限制。

### 4.8 `editing_rhythm`

使用 visualChanges 判断**视觉变化候选的时间分布**：

- 哪些区间变化密集；
- 哪些区间长期静态；
- 不同阶段变化频率是否明显不同。

不要把 visualChanges 直接叫“剪辑次数”或“镜头数”。

### 4.9 `shot_change`

当前能力只能提供：

> **视觉变化候选 + 部分代表帧中的类型判断。**

可以说：

- “0-5 分钟检测到 N 个视觉变化候选”；
- “在已读代表帧中，其中若干看起来是人物镜头 / PPT 切换”。

不能声称：

- “全片一共切了 N 个镜头”；
- “所有候选都已经分类成镜头 / PPT”。

ffmpeg scene-change ≠ shot detector。

### 4.10 `broll_usage`

只有实际读到 Frame，才能判断某个候选是否是 B-roll。

代表帧没有覆盖所有 visualChanges 时，只能描述“当前采样中观察到的 B-roll”，不能列成全片完整 B-roll 时间表。

### 4.11 `visual_emphasis`

观察颜色、字号、高亮框、箭头、局部放大、背景切换等强调方式。

“这个强调方式让观众注意力提升”属于 Interpretation，不是直接观察。

### 4.12 `content_visual_alignment`

结合：

```text
Transcript：作者说什么
Frames：画面显示什么
```

再判断：对齐 / 部分对齐 / 不对齐 / 装饰性。

这里不是唯一允许使用 Visual Data 的跨源场景。Frames 也可以作为 Audience / Market 的上下文证据；区别在于**最终要回答的是什么问题**。

### 4.13 `targeted_visual_question`

围绕用户指定时间点取目标 Frame + 邻域 Frame，只回答局部视觉问题，不扩张成全片风格报告。

### 4.14 `cover`

使用 Metadata 提供的封面 URL，不为了封面下载完整视频。

## 5. 跨 Intent 边界：共享证据，不混淆问题

### 与 `content_learn`

Visual 负责“画面怎么呈现”；Content 负责“作者说了什么、论证如何”。

同一任务可以同时使用二者。

### 与 `audience_insight`

Visual Protocol 不替观众下态度结论，但 Frames 可以解释观众到底在回应什么画面。

例如：

> “03:20 弹幕突然爆了，是因为画面展示了什么？”

可以由 Audience 负责反应、Frames 提供视觉上下文。

### 与 `market_research`

Visual 不能证明 Pain / Purchase Intent，但屏幕上的价格、功能状态、对比表可能是市场判断的上下文证据。

因此不要写“visual 跟 market 无直接关系”这种绝对规则。

## 6. Grounding

### 单帧判断

重要视觉观察至少给 Frame ID + 时间：

```text
观察：PPT 左侧标题、右侧示意图。
证据：F03 @ 01:23
```

### 跨帧结论

列多个不同时间点作为支撑。

### Interpretation

将“作用 / 体验”明确写成解释：

```text
观察：多个页面正文都压缩成 2-3 个短句。
证据：F03 / F07 / F12。
解释：这可能降低口播与屏幕文字的竞争。
```

不要把“可能作用”冒充 Frame 事实。

### 量化

量化 visualChanges 时明确单位是：

> visual-change candidates

不是镜头切换次数。

## 7. Coverage

视觉结论至少知道：

- mode；
- 实际 Frame 数；
- 覆盖的时间位置 / 范围；
- visualChanges 是否完整；
- 是否有 truncated / partial / warning；
- 当前 Focus 是否要求全片代表性。

代表性采样应尽量覆盖整条时间轴。若实际 Tool Plan 只覆盖前段，不能称“全片代表帧”。

推荐：

> “基于全片 12 个分散时间点的代表帧……”

而不是：

> “整个视频都……”

除非证据确实支持。

## 8. 输出形态

不写：

```text
设计感 8/10
高级感 7/10
```

可以按用户问题组织成：

```text
观察
→ 可能作用 / Interpretation
→ Frame 证据
→ 可借鉴点（用户确实想学习时）
```

数字化提示只是辅助观察，不是普适审美评分标准。

## 9. Multi-part

用户指定分P时，只分析该分P。

多P且用户要求整体视觉时，需要覆盖相关分P；不能把 P1 视觉结论推广到整个视频集合。

## 10. Capability Gap

当前不能可靠完成：

- 完整 shot classification；
- 音画卡点；
- 镜头运动轨迹；
- 动态特效全过程；
- OCR 精确识别；
- 自动美学评分；
- 多视频视觉比较。

遇到这些问题直接说明能力边界，不用静态帧假装完成。

## 11. 输出前自检

- Observation / Interpretation / Recommendation 是否分开？
- 是否把 scene-change candidate 写成 shot？
- 是否用少量 Frame 过度概括全片？
- `shot_change / broll_usage` 是否声称完成了未实际分类的候选？
- 数字提示是否被误写成设计质量阈值？
- 重要视觉判断是否有 Frame 时间？
- Coverage / truncation / partial 是否公开？
- 需要 Transcript / Comments / Danmaku 上下文时是否按问题补证据？
