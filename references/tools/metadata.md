# `bilibili.get_metadata` Tool 说明

## 目标

把用户提供的 B站视频 URL、BV号或 av号转换成独立、标准化的视频元信息结果。

处理链路：

```text
输入解析
  → B站请求与原始数据校验
  → VideoMetadata 标准化
  → 返回 VideoRef、metadata 和本次 acquisition
```

本 Tool 不获取字幕、弹幕、评论或视频流，也不创建跨 Tool 共享的聚合对象。

## 输入

```json
{
  "video": "https://www.bilibili.com/video/BVxxxx/",
  "includeTags": true
}
```

- `video`：必填，支持普通 B站视频 URL、BV号、av号；b23.tv 短链会先解析跳转。
- `includeTags`：默认 `true`。标签不是核心元信息，标签接口失败只会让采集状态变成 `partial`。

## 成功或部分成功输出

```json
{
  "success": true,
  "video": {
    "bvid": "BVxxxx"
  },
  "metadata": {
    "bvid": "BVxxxx",
    "title": "视频标题",
    "pages": []
  },
  "acquisition": {
    "dataKind": "metadata",
    "status": "success"
  }
}
```

- `video` 是用于关联其它 Tool 结果的轻量 `VideoRef`。视频级元信息结果不填写 `cid`。
- `metadata` 是标准化 `VideoMetadata`，多P详情位于 `metadata.pages`。
- `acquisition.status` 为 `success` 或 `partial`；标签失败时核心结果仍可用。
- 输出不包含 `VideoAsset`，也不会因为单P而把某个 `cid` 写入视频级 `VideoRef`。

## 失败输出

已知网络、接口或解析错误会返回结构化结果：

```json
{
  "success": false,
  "acquisition": {
    "dataKind": "metadata",
    "status": "failed",
    "reasonCode": "..."
  },
  "error": {
    "code": "...",
    "message": "...",
    "retryable": false
  }
}
```

失败时不伪造 `video` 或 `metadata`。Agent 根据 `retryable` 和用户目标决定是否重试或停止。

## 设计边界

- B站原始字段只存在于 `scripts/bilibili/*`。
- Tool 和 Agent 依赖 `VideoMetadata`，不依赖 `stat.view`、`owner.mid` 等平台原始字段。
- Metadata Tool 可以独立调用，不要求前一次 Tool 调用留下任何内存状态。
- Agent 只有确实需要标题、简介、分P、标签或统计信息时才调用本 Tool；字幕 Tool 会自行获取其职责所需的最小前置信息。

## 命令行调用

```bash
node <skill-root>/dist/cli.mjs tool metadata '{"video":"BV号或视频链接"}'
```

命令输出与上述 Tool 结果使用同一份结构。
