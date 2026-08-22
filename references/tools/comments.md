# 评论 / 回复 Tool

用于获取 B 站公开视频的根评论和指定根评论的回复线程。评论是 **video / aid 级数据，不分P**。

Tool 只负责采集、分页和确定性整理；Audience / Market 语义分析由宿主 Agent 完成。

## 1. `comments`

### 输入

```json
{
  "video": "BV... / av... / URL",
  "sort": 3,
  "cursor": "可选，下一页游标",
  "pageSize": 20
}
```

- `sort=3`：hot；
- `sort=2`：time；
- `pageSize`：1-30；
- 首次不传 `cursor`，继续分页时使用上次 `nextCursor`。

评论不接受 `cid / page / pageNum`。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool comments '{"video":"BV...","sort":3,"pageSize":20}' --compact
```

### 关键输出

```text
success
outcome: success | failed
video: { bvid }
collection:
  comments[]
  complete
  samplingStrategy?
  totalReported?
  metadata?
nextCursor?
acquisition
error?
```

`collection.complete=true` 只在平台明确表示当前目标范围已经结束时成立；否则按不完整处理。

## 2. `comment-replies`

当根评论的 `replyCount` 和语义价值说明值得深入时，按 root rpid 获取回复。

### 输入

```json
{
  "video": "BV... / av... / URL",
  "root": "根评论 rpid",
  "replyPage": 1,
  "pageSize": 20
}
```

- `replyPage` 是**回复分页页码**，不是视频分P；
- `pageSize`：1-49。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool comment-replies '{"video":"BV...","root":"123456","replyPage":1,"pageSize":20}'
```

### 关键输出

```text
success
outcome: success | failed
video: { bvid }
root
replies[]
page: { num, size, count }
totalReported?
lastPageReached?
hasMore?
complete?                 # 兼容字段，仅在第 1 页已含完整线程时为 true
nextReplyPage?
acquisition
error?
```

`lastPageReached` 只表示平台确认“当前返回的是最后一页”，不表示此前页面已经被本次无状态调用取得。`hasMore` 与它含义相反。

兼容字段 `complete=true` 只在第 1 页已经包含平台报告的全部回复时成立。直接请求第 2 页，即使 `lastPageReached=true`，也不能据此宣称整个回复线程完整。

单条 `Comment.repliesComplete` 只描述该 Comment 自己的 `replies[]` 是否完整，不能用来代替整个 root thread 的分页 Coverage。

## 3. Comment 语义

主要字段：

```text
id              = rpid
rootId          = 所属根评论 ID
parentId        = 直接父评论 ID
content         = 原始文本
likeCount       = 热度信号
replyCount      = 平台报告的回复数
publishedAt     = 发布时间
isPinned        = 是否置顶
replies[]       = 当前已取得的子回复
repliesComplete = 当前 Comment 的子回复是否完整
```

注意：

- `replies.length` 不能代替 `replyCount`；
- 高赞 / 置顶不等于代表性；
- `[已删除]` 不应继续做语义判断；
- 回复分析必须保留 root / parent 上下文。

## 4. `totalReported` 的边界

平台报告的总量字段不自动等于“根评论总体”。

因此：

- 可以作为平台规模背景；
- 不应直接拿来计算“根评论采样率”；
- Coverage 优先报告本次实际取得多少**去重根评论**、来自哪些排序 / 页。

## 5. hot + time 合并必须去重

同一 rpid 可能同时出现在 hot 和 time 样本。

在做精确计数、信号数量或 Market Coverage 前，使用确定性去重 helper 按 comment `id / rpid` 去重。

不要让 Agent 依靠自然语言记忆手工去重。

## 6. 分页与抽样

- quick：先取一页 / 少量样本；
- standard / deep：按 Evidence Gap 逐步翻页；
- selected replies：只深入与 Focus 强相关的根评论；
- 用户要求 complete：成本和风控允许时继续分页，否则明确 partial。

不要因为评论很多就默认抓完整回复树。

## 7. 失败与风控

评论和回复接口需要 WBI（网页接口签名），但 WBI 签名不等于登录。当前正式命令行入口默认匿名调用，也不会自动读取浏览器登录状态。

匿名请求可能正常返回，也可能因平台风控只得到有限数据、空数据或业务错误。因此：

- 不要把“浏览器已登录”当成 Tool 已经拥有登录身份；
- 不要把匿名空结果直接解释成评论区确实为空；
- 当前没有可执行的登录状态注入入口时，不要让用户反复登录浏览器作为重试方案；
- 依赖评论或回复的任务应根据实际采集状态公开数据缺口并降低结论范围。

任何失败以：

```text
outcome = failed
acquisition.status = failed
acquisition.reasonCode
error.code / message / retryable
```

表达。

B站接口可能限流或返回业务错误。Tool 报 partial / failed 后，Agent 按当前 Coverage 决定重试、降级或停止；不要在 Runtime 文档中假设固定 QPS。
