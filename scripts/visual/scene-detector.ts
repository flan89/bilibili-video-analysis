/**
 * scripts/visual/scene-detector.ts: ffmpeg scene-change 检测.
 *
 * 用 ffmpeg `select='gt(scene,THRESHOLD)'` filter 找视觉变化候选时间点.
 */
import { spawn } from "node:child_process";
import { z } from "zod";

/** 视觉变化候选. */
export const VisualChangeCandidateSchema = z.object({
  /** 视频内时间点 (秒). */
  timestampSeconds: z.number().nonnegative(),
});
export type VisualChangeCandidate = z.infer<typeof VisualChangeCandidateSchema>;

export class SceneDetectionError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "SceneDetectionError";
  }
}

export interface SceneDetectorOptions {
  ffmpegPath?: string;
  /** ffmpeg scene threshold, 默认 0.4 (跟 B 站推荐一致). */
  threshold?: number;
  /**
   * 内存保护上限, 防止 ffmpeg 输出过多导致 OOM.
   * 默认 5000, 超过会保留前 5000 + 标记 truncated.
   */
  maxCandidates?: number;
}

export interface SceneDetectorResult {
  /** 视觉变化候选 (按时间升序). */
  candidates: VisualChangeCandidate[];
  /** ffmpeg 实际检测到的候选数 (在 maxCandidates 保护上限之前). */
  totalDetected: number;
  /** 是否因为 maxCandidates 上限被截断. */
  truncated: boolean;
}

/**
 * ffmpeg `select='gt(scene,THRESHOLD)'` filter 触发时, ffmpeg 会输出
 * `frame:N pts:N ...` 到 stderr (因 showinfo). 我们只关心 pts_time 字段.
 *
 * 例:
 *   ffmpeg -i src -filter:v "select='gt(scene,0.4)',showinfo" -f null -
 */
const SCENE_FILTER_PATTERN = /pts_time:([0-9.]+)/g;

export async function detectVisualChanges(
  sourcePath: string,
  options: SceneDetectorOptions = {},
): Promise<SceneDetectorResult> {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const threshold = options.threshold ?? 0.4;
  // maxCandidates 改为内存保护上限 (默认 5000), 不再是结果截断.
  // visual-decode.md "代表帧 / 全时间轴" 协议不一致.
  const memoryCap = options.maxCandidates ?? 5000;

  const args = [
    "-i", sourcePath,
    "-filter:v", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null",
    "-",
  ];

  const { stdout, stderr, exitCode } = await runProcess(ffmpegPath, args);
  if (exitCode !== 0) {
    throw new SceneDetectionError(
      `ffmpeg scene detection 失败: ${stderr.slice(0, 300)}`,
      stderr,
      exitCode,
    );
  }

  // parse pts_time
  const all: VisualChangeCandidate[] = [];
  const pattern = new RegExp(SCENE_FILTER_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    const ts = Number.parseFloat(match[1] ?? "0");
    if (!Number.isFinite(ts)) continue;
    all.push({
      timestampSeconds: ts,
      // 不再返回 score: 旧版恒为 1.0 是假证据
    });
  }

  // ffmpeg 输出按时间升序, 保持不变.
  const totalDetected = all.length;
  const truncated = totalDetected > memoryCap;
  const candidates = truncated ? all.slice(0, memoryCap) : all;

  return { candidates, totalDetected, truncated };
}

function runProcess(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
