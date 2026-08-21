# 弹幕 Tool

用于获取单个 B 站视频 / 分P 的弹幕时间线。弹幕是**视频时间点上的即时反应**，不是稳定观点评论。

## 1. 输入

```json
{
  "video": "BV... / av... / URL",
  "cid": "可选",
  "page": 1,
  "maxSegments": 12
}
```

- 多P优先使用自然 `page`；
- URL 已有 `?p=N` 时可直接识别；
- `cid` 用于精确选择；
- `maxSegments` 限制最多获取多少个弹幕分段，可能导致 partial Coverage。

## 2. 调用

```bash
node <skill-root>/dist/cli.mjs tool danmaku '{"video":"BV...","page":1}' --compact
```

## 3. 输出

```text
success
outcome: success | selection_required | failed
video: { bvid, cid? }
danmaku:
  source
  cid
  segments[]
  total
  segmentCount
  complete
  metadata?
pageChoices?
acquisition
error?
```

单条 `segments[]` 主要字段：

```text
id
startSeconds
endSeconds      # 弹幕是瞬时事件，通常与 startSeconds 相同
text
mode
color
midHash?
sendTime?
weight?
pool
metadata?
```

## 4. 多P

多P视频未能唯一确定目标分P时，Tool 返回：

```text
outcome = selection_required
pageChoices[]
```

不要静默选择 P1。

## 5. Coverage

弹幕通常按时间分段获取。

判断完整性时同时看：

- `danmaku.complete`；
- `acquisition.status`；
- `warnings`；
- 实际 `segmentCount / maxSegments`；
- 是否存在分段失败。

只要 acquisition 是 partial 或存在未覆盖分段，就不能据此比较全片峰值或宣称“全片弹幕”。

## 6. 语义边界

- `midHash` 是脱敏发送者标识，只用于去重 / 匿名关联，不反查用户；
- `weight` 是平台字段，不解释为观点可信度、情绪强度或用户质量；
- 重复文本可能是共鸣，也可能是梗 / 跟风 / spam；
- 高弹幕密度不等于高赞同；
- 需要解释触发原因时，按问题补 Transcript 或 Frames。

## 7. 失败

失败统一从 `outcome / acquisition / error` 判断。

常见类别包括：视频解析失败、metadata / aid / cid 前置失败、分P选择冲突、弹幕接口失败等。具体 `reasonCode` 以 Tool 实际返回为准，不在 Analysis Protocol 中复制维护。
