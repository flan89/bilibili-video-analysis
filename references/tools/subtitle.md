# `bilibili.get_subtitle` Tool 说明

## 目标与边界

只凭用户已有的视频标识获取官方字幕，并返回 Agent 可直接阅读的干净 `Transcript`：

```text
视频 URL、BV号或 av号
  → 内部获取字幕所需的最小元信息
  → 确定目标 cid
  → 发现并选择官方字幕轨
  → 下载、标准化并确定性清理字幕
  → 返回独立 SubtitleResult
```

本 Tool 优先处理官方人工字幕和平台生成字幕。官方字幕缺失时会尝试本地 ASR（自动语音识别）；如果运行环境尚未准备，则返回结构化失败信息和 `setupHint`，由 Agent 在用户授权后准备环境并重试。

## 输入

```json
{
  "video": "BVxxxx",
  "page": 2,
  "cid": "可选分P cid",
  "language": "可选语言代码"
}
```

- `video`：必填，支持普通 B站视频 URL、BV号、av号和 b23.tv 短链。
- `page`：可选，从 1 开始的自然分P编号。视频 URL 的 `?p=N` 具有相同作用。
- `cid`：可选的底层分P身份，主要用于精确重试；普通 Agent 调用优先使用 `page`。
- `language`：可选，既支持标准化语言代码，也兼容 B站来源代码，例如 `ai-zh`。

显式 `page` 与 URL 的 `p` 不一致，或 `cid` 与指定分P不一致时，Tool 返回结构化失败，不静默覆盖用户选择。

Tool 不要求 Agent 先调用 Metadata Tool，也不接收跨调用共享对象。

## 输出结果

`outcome` 有四种：

- `success`：得到可用 `Transcript`；正文存在少量坏片段时仍可成功，但采集状态为 `partial`。
- `missing`：目标语言不存在、正文为空，或官方字幕和本地语音识别都未能产生可用结果。语音识别成功时，Tool 返回 `transcript.source = "asr"`，采集状态可能是 `success` 或 `partial`。Agent 不应把“官方字幕缺失”直接理解为 Tool 没有替代能力。
- `selection_required`：多P尚未选定，返回 `pageChoices`，且不发送字幕轨或正文请求。
- `failed`：元信息、字幕接口、协议或正文下载失败，返回结构化 `error`。

### `transcript.source` 的三种来源

Agent 拿到 `transcript.source` 时，应区分三种来源的可靠程度：

| 来源 | 含义 | 可信度 |
| --- | --- | --- |
| `official` | B 站官方上传字幕 + 确定性清洗 | 最高, 视频作者亲手写 |
| `official_ai` | B 站官方 AI 字幕 (早期视频常见) | 中, 跟 ASR 接近 |
| `asr` | 本地语音识别得到的转写 | 最低，受语音活动检测、分段和模型能力影响 |

当 `source="asr"` 时，Agent 应结合 `acquisition.warnings` 和 `transcript.complete` 判断时间位置是否可信：

- `transcript.complete = true` + warnings 为空 → 时间锚点可信, 可正常引用 "03:20 作者说了什么"
- `transcript.complete = false` + warnings 含 `asr_vad_no_segments_detected` → 整段 fallback 到 from=0,to=0, 时间锚点全在 00:00, **不能**做时间点引用
- `transcript.complete = false` + warnings 含 `asr_vad_filtered_short_segments` → VAD 过滤了 < 1s 段, 短词 ("对" / "不" / "99" / "GPT") 可能丢失

正常情况下，Tool 在官方字幕缺失时自动尝试本地语音识别。`BILIBILI_SKILL_FORCE_ASR=1` 只用于开发者跳过官方字幕、强制验证语音识别链路，不应在普通 Agent 任务中使用。

成功结果示意：

```json
{
  "success": true,
  "outcome": "success",
  "video": {
    "bvid": "BVxxxx",
    "cid": "123456"
  },
  "transcript": {
    "source": "official",
    "language": "zh-CN",
    "cid": "123456",
    "complete": true,
    "segments": []
  },
  "processing": {
    "method": "deterministic_v1",
    "warnings": [],
    "stats": {
      "inputSegmentCount": 0,
      "outputSegmentCount": 0,
      "emptySegmentCount": 0,
      "duplicateSegmentCount": 0
    }
  },
  "availableTracks": [],
  "acquisition": {
    "dataKind": "transcript",
    "status": "success"
  }
}
```

`availableTracks` 只暴露语言、来源、格式和可用性，不暴露带时效签名的正文地址。

## 字幕与清理规则

- `source`：人工字幕为 `official`，平台生成字幕为 `official_ai`。
- `language`：使用标准化语言代码；平台来源代码保留在字幕扩展信息中。
- `cid`：始终填写当前分P。
- `segments`：保留稳定编号、开始时间、结束时间和文本，并按开始时间排序。
- `complete`：来源正文有片段被跳过时为 `false`。
- `provider`：`bilibili`。

确定性清理只做：

- 统一空白和换行；
- 丢弃清理后为空的片段；
- 合并时间相邻、文本完全相同且说话人一致的片段；
- 合并后在 `segment.metadata.sourceSegmentIds` 中保留全部来源编号。

清理不改写词语、数字、术语或原意，不进行模糊去重，也不判断章节和内容重要性。`processing` 让 Agent 看见清理实际产生的数量变化和警告。

## 多P与失败处理

- 多P没有 `page`、URL `p` 或 `cid` 时返回 `selection_required` 和 `pageChoices`，不默认使用第一P。
- URL `?p=N` 和 `--page N` 会根据元信息中的分P列表转换成对应 `cid`。
- 指定分P编号不存在时返回 `unknown_page`，不回退到第一P。
- 显式 `cid` 不属于当前视频时返回 `failed`。
- 目标语言不存在时返回 `missing`，并保留可用轨道摘要供 Agent 判断下一步。
- 字幕轨接口首次返回空结果时，Tool 会在内部再复核一次。连续两次为空或补充复核失败时进入 ASR 降级，并在 `warnings` 中说明空轨不确定性；Agent 不要为确认空结果立即重复整次 Tool 调用。
- 元信息前置请求失败时，由本 Tool 返回字幕任务的结构化失败结果，不要求 Agent 拼接两次调用。
- `Transcript.complete=false` 或 `acquisition.status=partial` 时，Agent 必须在分析中保留覆盖限制。
- 本地 ASR 环境缺失时会返回 `setupHint`。先执行其中的 `planCommand` 并向用户说明成本；只有得到明确授权后才能执行 `applyCommand`。Tool 本身不会安装依赖或下载模型。

## 平台适配

当前播放器通过 `/x/v2/subtitle/web/view` 返回二进制字幕轨信息，字幕正文为独立 JSON。二进制解码、正文地址转换、域名限制和原始字段映射全部位于 `scripts/bilibili/*`，不会扩散到 Tool 契约。

字幕正文只允许请求已知 B站字幕域名，避免平台返回异常地址时访问任意外部站点。

## 命令行调用

Agent 直接分析字幕时使用紧凑输出：

```bash
node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接"}' --compact
node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接?p=2"}' --compact
node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接","page":2,"language":"zh-CN"}' --compact
```

紧凑输出保留：

- `success / outcome`；
- 视频和分P身份；
- 字幕来源、语言和完整性；
- 全部字幕文本、顺序、开始与结束时间；
- 连续 `segmentNumber`；
- 采集、清理、多P、降级和错误状态。

它会省略每条字幕重复的长 sourceId 和扩展 metadata，避免普通视频的结构化输出不必要地占用 Agent 上下文，但仍保留全部字幕正文，因此较长视频的输出依然可能很大。如果当前运行环境容易截断长输出，可优先在调用时把结果保存到本地文件，再从文件中分段读取或进行确定性整理；是否需要重新调用由 Agent 根据当前结果和执行环境自行判断。完整 Tool 函数和不带 `--compact` 的命令仍返回原始 JSON 契约。

引用 `official_ai` 或 `asr` 字幕时，不要把按上下文修正后的文本静默放进引号。具体引用规则见 [`content-learn`](../analysis/content-learn.md) §3.5。

需要检查完整程序结果时使用：

```bash
node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接"}'
node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接","page":2,"language":"zh-CN"}'
```

正式 Skill 发布物已经包含单文件运行包，不需要在用户机器执行 `npm install`。`npm` 与 TypeScript 只用于仓库开发。

需要登录态时可以临时传入：

```bash
BILIBILI_COOKIE='本机 Cookie' node <skill-root>/dist/cli.mjs tool subtitle '{"video":"BV号或视频链接"}'
```

命令不会打印 Cookie，也不应把 Cookie 写入固定样例或提交到仓库。
