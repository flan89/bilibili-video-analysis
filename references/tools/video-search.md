# 视频搜索 Tool

用于按关键词搜索B站公开视频，返回当前页的候选元信息。这是 `topic_research` 阶段一的发现入口。

Tool 只负责采集、参数映射和确定性清理（去高亮、URL 规范化、时长解析）；搜索词设计、候选选择和何时停止由宿主 Agent 按发现策略决定。

## 1. `search-videos`

### 输入

```json
{
  "query": "Agent Skill 设计",
  "page": 1,
  "pageSize": 20,
  "order": "relevance",
  "duration": "10_to_30m"
}
```

- `query`：单个自然语言搜索词，必需。多个搜索词由 Agent 分多次调用；
- `page`：页码，默认 1；
- `pageSize`：每页数量，默认 20，上限 20；
- `order`：`relevance`（综合排序）/ `latest`（最新发布）/ `views`（播放）/ `danmaku`（弹幕）/ `favorites`（收藏），默认 `relevance`；
- `duration`：`under_10m` / `10_to_30m` / `30_to_60m` / `over_60m`，平台原生筛选。

**不提供发布时间筛选**：平台搜索接口的时间参数实测被忽略，本地过滤只覆盖当前页、会制造错误的"无结果"语义。需要按时间研究时，用 `order: "latest"` 取候选，再根据候选自带的 `publishedAt` 自行判断。

排序和时长是筛选辅助，不是内容质量信号。用 `views` 排序 ≠ 播放量高的视频更有代表性。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool search-videos '{"query":"Agent Skill 设计","order":"relevance"}' --compact
```

Agent 初筛默认使用 `--compact`。它省略长简介、封面和头像，但保留候选身份、标题、作者、位置、统计、分页、采集状态和全部 `warnings`。需要核对完整候选字段时才使用不带该选项的命令；不要只为改变展示格式重复请求同一页。

### 关键输出

```text
success
query: { keyword, order, page, pageSize, duration? }
candidates[]
  video: { bvid }
  title                # 已去掉平台高亮标记
  description?
  author?              # UP 主最小公开引用
  publishedAt?         # Unix 秒
  durationSeconds?
  coverUrl?
  tags[]
  stats?               # viewCount / danmakuCount / favoriteCount（接口返回时才有）
  position             # 当前页内的原始位置，便于回查
  sourceUrl?
pageInfo: { page, pageSize, returnedCount, hasNextPage }
reportedTotal?         # 平台报告的结果总数
observedAt             # 本次观察时间
acquisition
error?
```

注意：

- 候选不是完整 `VideoMetadata`：不调详情接口补齐字段，不伪造点赞、评论数等搜索接口没有返回的数据；
- `position` 是**当前页内**位置，不是跨页或全站排名；
- `hasNextPage` 是保守估计，只表示“可能还有下一页”。

## 2. `reportedTotal` 的边界

`reportedTotal` 只是平台在当前接口中报告的数值：

- 达到平台搜索上限（≥1000）时 Tool 会写入 warning，此时它不代表真实相关视频总数；
- 它不能作为“B站共有 N 个相关视频”的表述依据；
- Coverage 应报告本次实际查看了多少候选、来自哪些搜索词和页。

## 3. 空结果、部分结果与失败

| 场景 | 表达 |
|---|---|
| 请求成功但没有候选 | `success=true`，`acquisition.status=missing` |
| 有候选但筛选或字段不可靠 | `success=true`，`acquisition.status=partial`，看 `warnings` |
| 网络 / 结构 / 业务错误 / 风控 | `success=false`，`acquisition.status=failed`，看 `error` |

## 4. 失败与风控

搜索接口使用 Web 端 WBI 签名，匿名调用。可能遇到：

- **HTTP 412 或业务 -412**：`error.code=search_risk_control`，`retryable=true`。表示稍后重试可能有意义，但**不应立即连续重试**；发现风控后应停止追加翻页，用已有候选继续或公开无法完成发现；
- 其它业务错误：`search_api_error`；
- 响应结构变化：`search_invalid_response`（不可重试）；
- 网络异常：`search_network_error`（可重试）。

已经取得前一页、后续页失败时：可以使用已有候选继续研究，但必须把搜索覆盖写成部分范围。

## 5. 分页与停止

一次调用只返回一页，Tool 不自动批量翻页：

- `quick` 找视频：一页通常就够；
- `standard` / `deep`：按发现策略翻页（默认总共约 20～40 条候选）；
- 满足差异化样本、风控、空结果或新增信息很低时停止，见 [`references/discovery-strategy.md`](../discovery-strategy.md) §5。

不要为了“完整”自动翻完所有页；也不要只因为第一页 20 条就宣称覆盖了整个主题。
