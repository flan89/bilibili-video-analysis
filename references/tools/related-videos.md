# 关联推荐 Tool

用于获取B站围绕某个给定视频的关联推荐列表快照。这是 `topic_research` 的发现来源之一，回答"平台围绕这个视频推荐了什么"。

Tool 只负责采集和确定性清理（URL 规范化、统计转换、种子自身过滤、重复 BV 号去重）；选择哪些候选深入、是否补一次关键词搜索、何时停止由宿主 Agent 按发现策略决定。

**来源机制边界**：结果来自平台推荐机制的邻接关系快照，**不保证主题等价、观点相关或代表性抽样**。回答时必须表述这一点，禁止写成"和这个视频同主题的代表视频"或"相关领域最全的视频"。

## 1. `related-videos`

### 输入

```json
{
  "video": "BV号或视频链接",
  "limit": 20
}
```

- `video`：种子视频，支持 B站视频 URL、BV号或 av号；
- `limit`：本地截取上限，默认 20，上限 40。

没有翻页参数：平台单次返回整组推荐（实测约 40 条），接口没有可靠分页契约。不接受 Cookie，不承诺登录用户的个性化推荐流。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool related-videos '{"video":"BV1xxxxxxxxx","limit":20}' --compact
```

Agent 初筛默认使用 `--compact`。它省略长简介、封面和头像，但保留种子身份、候选身份、位置、统计、采集状态和全部 `warnings`。需要核对完整候选字段时才使用不带该选项的命令；不要只为改变展示格式重复请求同一快照。

### 关键输出

```text
success
seedVideo: { bvid }    # 种子视频引用; 输入只有 av 号时缺省
candidates[]
  video: { bvid }
  title
  description?
  author?              # UP 主最小公开引用
  publishedAt?         # Unix 秒
  durationSeconds?
  coverUrl?
  tags[]               # 关联来源不返回标签, 恒为空
  stats?               # viewCount / danmakuCount / favoriteCount / likeCount /
                       # replyCount / coinCount / shareCount（接口返回时才有）
  position             # 本次关联推荐列表中的原始位置，便于回查
  sourceUrl?
  category?            # { id?, name? } 平台分区最小信息
returnedCount          # 平台原始返回条数（截取前）
observedAt             # 本次观察时间
acquisition            # dataKind=related_video_candidates
error?
```

注意：

- `position` 是**本次关联推荐列表内**的位置，不是全站排名；
- 平台意外返回种子视频自身时已按 BV 号或 av 号确定性过滤并写入 `warnings`；相同 BV 号只保留首次出现；
- 该接口当前不返回推荐理由文本（与热门接口不同），候选没有 `discoveryReason`；
- 候选可能混入分区差异很大的视频，这正是推荐邻接关系的真实形态，不代表 Tool 出错。

## 2. 空结果、部分结果与失败

| 场景 | 表达 |
|---|---|
| 请求成功但列表为空 | `success=true`，`acquisition.status=missing` |
| 有候选但个别条目被跳过（如 OGV 番剧条目缺 BV 号） | `success=true`，`acquisition.status=partial`，看 `warnings` |
| 网络 / 结构 / 业务错误 / 风控 | `success=false`，`acquisition.status=failed`，看 `error` |

## 3. 失败与风控

关联推荐接口匿名调用，无需 WBI 签名（Tool 已内置普通浏览器请求头）。可能遇到：

- **输入格式不受支持**：本地返回 `invalid_video_input`，表示尚未向B站发起请求，不是平台故障；
- **格式有效但种子视频不存在**：`error.code=related_api_error`（平台 code=-400），不可重试；
- **HTTP 412 或业务 -352/-412**：`error.code=related_risk_control`，`retryable=true`。表示稍后重试可能有意义，但**不应立即连续重试**；
- 其它业务错误：`related_api_error`；
- 响应结构变化：`related_invalid_response`（不可重试）；
- 网络异常：`related_network_error`（可重试）。

用户明确要求关联推荐而接口失败时：**公开失败，不用关键词搜索结果冒充关联推荐**；可建议改用 `search-videos` 继续发现，但必须说明来源不同。

## 4. 深挖与停止

一次调用只返回围绕种子视频的一组推荐，Tool 不递归获取"关联视频的关联视频"：

- 从关联列表继续研究时，只**选择少量候选**（默认 3～5 个）使用字幕、评论、画面等单视频 Tool，不分析全部条目；
- 关联推荐只反映推荐链，容易被单一推荐图限制视野；需要覆盖某主题时，应补一次 `search-videos` 并说明两个来源各自的角色；
- 比较多个候选时，说明它们来自"平台关联推荐"而不是"主题代表抽样"；
- 停止与来源组合规则见 [`references/discovery-strategy.md`](../discovery-strategy.md)。

不要把一次关联推荐快照写成"长期稳定推荐关系"；不要把关联推荐与搜索、热门结果静默合并成单一列表而不标注来源。
