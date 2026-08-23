# 当前热门 Tool

用于获取B站综合热门页面当前展示的视频列表快照。这是 `topic_research` 的发现来源之一，回答"平台热门机制现在在展示什么"。

Tool 只负责采集和确定性清理（URL 规范化、统计转换、推荐理由文本提取）；是否继续翻页、选择哪些候选深入、何时停止由宿主 Agent 按发现策略决定。

**来源机制边界**：结果来自平台热门机制的当前快照，**不是全站客观质量排名，也不是排行榜**。回答时必须表述这一点，禁止写成"B站最好的视频"或"当前热门就是排行榜"。

## 1. `popular-videos`

### 输入

```json
{
  "page": 1,
  "pageSize": 20
}
```

- `page`：页码，默认 1；
- `pageSize`：每页数量，默认 20，上限 20。

不提供关键词、分区、排序和时间范围：这些不是当前热门接口的真实能力。不接受 Cookie，不承诺登录用户的个性化推荐流。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool popular-videos '{"page":1,"pageSize":20}' --compact
```

Agent 初筛默认使用 `--compact`。它省略长简介、封面和头像，但保留候选身份、位置、统计、分页、采集状态和全部 `warnings`。需要核对完整候选字段时才使用不带该选项的命令；不要只为改变展示格式重复请求同一页。

### 关键输出

```text
success
candidates[]
  video: { bvid }
  title
  description?
  author?              # UP 主最小公开引用
  publishedAt?         # Unix 秒
  durationSeconds?     # 热门接口直接返回秒数值
  coverUrl?
  tags[]               # 热门来源不返回标签, 恒为空
  stats?               # viewCount / danmakuCount / favoriteCount / likeCount /
                       # replyCount / coinCount / shareCount（接口返回时才有）
  position             # 当前热门列表中的原始位置，便于回查
  sourceUrl?
  category?            # { id?, name? } 平台分区最小信息
  discoveryReason?     # 平台热门推荐理由文本，例如"百万播放"
pageInfo: { page, pageSize, returnedCount, hasNextPage }
observedAt             # 本次观察时间
acquisition            # dataKind=popular_video_candidates
error?
```

注意：

- `discoveryReason` 只是平台推荐理由标签（常为播放/点赞量级描述），不是对内容质量的判断；
- `position` 是**当前热门列表内**的位置，不是全站排名；
- `hasNextPage` 优先根据平台 `no_more` 标记确定，比搜索接口的满页估计更可靠。

## 2. 空结果、部分结果与失败

| 场景 | 表达 |
|---|---|
| 请求成功但列表为空 | `success=true`，`acquisition.status=missing` |
| 有候选但个别条目被跳过 | `success=true`，`acquisition.status=partial`，看 `warnings` |
| 网络 / 结构 / 业务错误 / 风控 | `success=false`，`acquisition.status=failed`，看 `error` |

## 3. 失败与风控

热门接口匿名调用，无需 WBI 签名，但必须携带普通浏览器请求头（Tool 已内置）。可能遇到：

- **HTTP 412 或业务 -352/-412**：`error.code=popular_risk_control`，`retryable=true`。表示稍后重试可能有意义，但**不应立即连续重试**；
- 其它业务错误：`popular_api_error`；
- 响应结构变化：`popular_invalid_response`（不可重试）；
- 网络异常：`popular_network_error`（可重试）。

用户明确要求当前热门而热门接口失败时：**公开失败，不用关键词搜索结果冒充热门**。

## 4. 分页与停止

一次调用只返回一页，Tool 不自动批量翻页：

- `quick` 看热门：取得一页后即停止，按可观察主题做轻量归纳；
- 用户进一步要求分析内容时，才从列表中**选择少量候选**（默认 3～5 个）使用字幕、评论、画面等单视频 Tool，不分析全部热门条目；
- 停止与来源组合规则见 [`references/discovery-strategy.md`](../discovery-strategy.md)。

不要把一次热门快照写成"持续上升趋势"；不要把热门列表与其它来源合并后按位置或热度排序。
