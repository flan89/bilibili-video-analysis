/**
 * scripts/visual/media-probe.ts: ffprobe 包装, 拿视频/音频元信息.
 *
 * 用 ffprobe 拿视频时长 / 分辨率 / 帧率, 给 FrameSet.coverage
 * 和 PlayURL 决策用.
 *
 * D12 边界: 本文件只调 ffprobe 拿元信息, 不做抽帧.
 * 抽帧逻辑在 frame-extractor.ts.
 */
import { spawn } from "node:child_process";
import { z } from "zod";

/** ffprobe 拿到的核心媒体元信息. */
export const MediaProbeResultSchema = z.object({
  /** 媒体时长 (秒, 来自 format.duration). */
  durationSeconds: z.number().nonnegative(),
  /** 视频流信息 (有视频流时存在). */
  video: z
    .object({
      /** 编码格式 (例: h264 / hevc). */
      codec: z.string().optional(),
      /** 分辨率. */
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** 平均帧率 (浮点). */
      fps: z.number().positive().optional(),
      /** 比特率 (bps). */
      bitrate: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** 音频流信息 (有音频流时存在). */
  audio: z
    .object({
      codec: z.string().optional(),
      sampleRate: z.number().int().positive().optional(),
      channels: z.number().int().positive().optional(),
    })
    .optional(),
});
export type MediaProbeResult = z.infer<typeof MediaProbeResultSchema>;

/**
 * ffprobe 找不到或解析失败.
 */
export class MediaProbeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "MediaProbeError";
  }
}

/**
 * 调 ffprobe 拿媒体元信息.
 *
 * @param filePath 本地媒体文件路径 (mp4 / m4s 等)
 * @param ffprobePath ffprobe 路径 (默认 "ffprobe" 走 PATH)
 * @returns 标准化元信息
 */
export async function probeMedia(
  filePath: string,
  ffprobePath = "ffprobe",
): Promise<MediaProbeResult> {
  const args = [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    filePath,
  ];

  const { stdout, stderr, exitCode } = await runProcess(ffprobePath, args);
  if (exitCode !== 0) {
    throw new MediaProbeError(
      `ffprobe 失败 exit=${exitCode}: ${stderr.slice(0, 300)}`,
      stderr,
      exitCode,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new MediaProbeError(
      `ffprobe JSON 解析失败: ${(e as Error).message}`,
      stderr,
      exitCode,
    );
  }

  return normalizeProbeResult(parsed);
}

/**
 * ffprobe JSON 输出 -> MediaProbeResult.
 *
 * 关注: 视频流用 codec_name (例: h264), 分辨率 width/height, 平均帧率 avg_frame_rate (例: "30/1" 或 "30000/1001").
 */
function normalizeProbeResult(raw: unknown): MediaProbeResult {
  const obj = raw as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string | number;
      sample_rate?: string;
      channels?: number;
    }>;
  };

  const durationSeconds = obj.format?.duration
    ? Number.parseFloat(obj.format.duration)
    : 0;

  const videoStream = obj.streams?.find((s) => s.codec_type === "video");
  const audioStream = obj.streams?.find((s) => s.codec_type === "audio");

  const result: MediaProbeResult = { durationSeconds };

  if (videoStream?.width && videoStream?.height) {
    result.video = {
      codec: videoStream.codec_name,
      width: videoStream.width,
      height: videoStream.height,
      fps: parseFrameRate(videoStream.avg_frame_rate),
      bitrate:
        typeof videoStream.bit_rate === "string"
          ? Number.parseInt(videoStream.bit_rate, 10)
          : videoStream.bit_rate,
    };
  }

  if (audioStream) {
    result.audio = {
      codec: audioStream.codec_name,
      sampleRate:
        typeof audioStream.sample_rate === "string"
          ? Number.parseInt(audioStream.sample_rate, 10)
          : audioStream.sample_rate,
      channels: audioStream.channels,
    };
  }

  return result;
}

/**
 * "30/1" 或 "30000/1001" 解析为数字.
 */
function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw || raw === "0/0") return undefined;
  const [num, den] = raw.split("/").map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

/**
 * 调子进程 + 收集 stdout/stderr.
 * 测试时可用 ffmpegPath 注入 (但 ffprobe 实际可执行文件通常固定).
 */
function runProcess(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
