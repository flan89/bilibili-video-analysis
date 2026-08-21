# 无官方字幕时的本地语音转写

本文件说明 B站官方字幕缺失时，Skill 如何通过 ASR（自动语音识别）取得可供 Agent 分析的 `Transcript`。

## 1. 使用位置

字幕获取优先级如下：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | B站官方字幕轨 | 主路径，包括 UP 主上传字幕和平台生成字幕 |
| 2 | 本地语音转写 | 官方字幕缺失时的替代路径 |

B站视频采用 DASH 等流媒体协议时，字幕通常由独立接口提供，并不是可以直接从视频文件中抽出的内嵌字幕流。因此，官方字幕缺失后才考虑下载音频并转写。

当官方字幕可用时，Skill 不应重复执行本地语音识别。

## 2. 工作流程

```text
确认官方字幕缺失
  ↓
取得视频音频流
  ↓
ffmpeg 转为 16 kHz 单声道 WAV
  ↓
语音活动检测切分音频
  ↓
SenseVoice-Small 分段转写
  ↓
标准化为 Transcript
  ↓
返回 source="asr" 的字幕结果
```

正式发布物中的实现位于 `runtime/python/`，TypeScript Tool 通过统一运行入口调用这些脚本。`runtime/` 是正式 Skill 的必要组成，不能在安装或发布时省略。

## 3. 环境准备

本地转写需要：

- `ffmpeg` 和 `ffprobe`；
- Python 隔离环境；
- 固定版本的 Python 依赖；
- 本地语音识别模型。

Tool 不会自动安装这些依赖。环境缺失时会返回结构化的 `setupHint`，由 Agent 向用户说明用途、预计变更和成本。只有用户明确同意后，才执行准备命令。

查看准备计划：

```bash
node dist/cli.mjs setup asr --plan
```

用户确认后执行：

```bash
node dist/cli.mjs setup asr --apply
```

只读检查：

```bash
node dist/cli.mjs doctor --json
```

## 4. 常见失败原因

调用方可以通过 `acquisition.reasonCode` 判断失败类型：

| reasonCode | 含义 |
|---|---|
| `asr_python_not_found` | Python 解释器不可用 |
| `asr_timeout` | 转写超过允许时间 |
| `asr_pipeline_unparseable` | 转写流程异常退出，且没有返回可解析结果 |
| `asr_pipeline_invalid_schema` | 返回数据不符合内部模型 |
| `asr_pipeline_exception` | 转写流程出现未处理异常 |
| `asr_transcript_missing` | 流程结束但没有生成字幕结果 |
| `asr_transcript_unreadable` | 字幕结果无法读取或解析 |
| `asr_unavailable` | 字幕 Tool 对不可用状态的统一包装 |

Agent 应结合 `outcome`、`acquisition.status`、`warnings` 和 `setupHint` 判断是准备环境、重试、使用其它来源，还是向用户说明能力缺口。

## 5. 缓存

语音转写结果默认缓存在：

```text
~/.cache/bilibili-skill/transcript/<bv>.transcript.json
```

可以通过 `BILIBILI_SKILL_CACHE_DIR` 覆盖缓存根目录。

缓存命中时跳过重复转写；转写成功后才写缓存；缓存读取或写入失败不应掩盖主要结果。音频下载地址有效期较短，因此不把远程地址当成长期资产。

## 6. 开发调试

如果视频已经有官方字幕，但开发者需要验证本地转写链路，可以临时设置：

```bash
BILIBILI_SKILL_FORCE_ASR=1 node dist/cli.mjs tool subtitle '{"video":"BV号或视频链接"}' --compact
```

这个开关只用于开发调试，不是 Tool 的公开输入字段，也不应由 Agent 在普通任务中主动使用。

查看单个视频的缓存：

```bash
python3 -m json.tool ~/.cache/bilibili-skill/transcript/<bv>.transcript.json
```

调试真实视频时可能涉及较大的下载、模型初始化和第三方网络访问，不应混入默认单元测试。

## 7. 已知限制

- 专有名词、产品名、数字和中英文混合表达可能识别错误；
- 语音活动检测和分段可能影响长句边界；
- 模型首次准备耗时较长，并占用额外磁盘空间；
- 受限视频、地区限制、登录状态和平台接口变化可能导致音频无法取得；
- 缓存目前不提供自动清理策略；
- `source="asr"` 的结果不应与人工字幕拥有相同的证据强度。

当重要结论依赖人名、产品名、数字或专业术语时，Agent 应结合上下文核对；无法确认时应降低表述强度并说明转写风险。
