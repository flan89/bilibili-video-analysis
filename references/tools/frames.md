# 视觉帧 Tool

用于从单个 B 站视频 / 分P 中取得代表帧和视觉变化候选时间线。Tool 负责下载、ffmpeg 提帧和确定性 Coverage；视觉语义由 Agent Vision + `visual-decode.md` 完成。

## 1. 输入

```json
{
  "video": "BV... / av... / URL",
  "cid": "可选",
  "page": 1,
  "mode": "interval",
  "intervalSeconds": 60,
  "maxFrames": 12,
  "sceneThreshold": 0.4,
  "resolution": "720p"
}
```

### `timestamp`

```json
{
  "video": "BV...",
  "mode": "timestamp",
  "timestamps": [30, 90, 150]
}
```

适合精准问题和已知时间点。

### `interval`

```json
{
  "video": "BV...",
  "mode": "interval",
  "intervalSeconds": 60,
  "maxFrames": 12
}
```

适合全片代表性视觉采样。最终要检查实际 Frame 时间是否覆盖整条时间轴。

### `scene`

```json
{
  "video": "BV...",
  "mode": "scene",
  "sceneThreshold": 0.4,
  "maxFrames": 20
}
```

返回：

- `visualChanges`：ffmpeg scene-change 候选时间点；
- `frames`：从候选时间轴中选择的代表 jpg。

`visualChanges` 是视觉变化候选，不是精确 Shot Detection。

## 2. 调用

```bash
node <skill-root>/dist/cli.mjs tool frames '{"video":"BV...","mode":"interval","intervalSeconds":60,"maxFrames":12}'
```

## 3. 输出

```text
success
outcome: success | selection_required | failed
video
frameset?
pageChoices?
acquisition?
error?
reasonCode?     # 兼容 alias；权威失败信息优先看 acquisition / error
message?
setupHint?       # 缺少 ffmpeg 时给出 doctor / plan / apply 三条结构化命令
```

`frameset` 关键字段：

```text
video
mode
frames[]
coverage
visualChanges?                 # scene mode
visualChangesTotal?
visualChangesTruncated?
acquisition
warnings[]
metadata?
```

Frame：

```text
id
timestampSeconds
uri          # file:///... 本地绝对 URI
reason
width?
height?
```

Agent 读取 `uri` 指向的 jpg，不假设某个特定 Agent 客户端 attachment 协议。

## 4. Coverage

`coverage.complete` 表示：

> **请求的采样计划是否完成。**

它不表示：

> “这些 Frame 已经完整代表视频所有视觉信息。”

必须同时关注：

- actual frame count；
- `plannedFrameCount / requestedFrameCount / extractedFrameCount`；
- `truncated`；
- 覆盖时间范围；
- `visualChangesTruncated`；
- `warnings`；
- `acquisition.status`。

如果代表帧只覆盖前段，就不能称“全片代表采样”。

## 5. scene mode 的关键语义

- `visualChanges`：视觉变化候选时间线；
- `visualChangesTotal`：Tool 检测到的候选总量；
- `visualChangesTruncated=true`：时间线被内存保护截断，不能据此做全片变化统计；
- `frames`：有限数量的可读 jpg，不覆盖每一个 candidate。

因此：

- editing rhythm 可以使用完整 visualChanges 的分布；
- shot / PPT / B-roll 类型必须基于实际 Frame 判断；
- 不要把 candidate 数量写成镜头切换数。

## 6. 多P

多P视频未指定唯一分P时返回 `selection_required + pageChoices`，不要静默选择 P1。

## 7. Resolution 与视频流

默认 720p，通常更稳定且成本较低。需要读取小字 / UI / typography 时可尝试 1080p，但高质量视频流可能受登录态和 B站实际返回能力限制。

DASH 路径如果 Tool / warning 表明只取得部分媒体内容，应按 partial / unverified 处理，不把局部视频当完整源。

## 8. Capability Gap

静态 Frame 不能可靠回答：

- 转场动画；
- zoom / 镜头运动；
- 音画卡点；
- 动态特效全过程；
- PPT 内部动画；
- 精确 Shot Classification；
- OCR 高精度文字识别。

需要这些能力时明确说明限制。

## 9. 失败

失败时优先读取：

```text
outcome
acquisition.status / reasonCode / warnings
error.code / message / retryable
```

顶层 `reasonCode / message` 仅作为兼容 alias。

具体错误可能来自：视频信息、分P选择、playurl、ffmpeg、scene detection、frame extraction 等。不要在 Analysis Protocol 中复制维护错误码列表。
