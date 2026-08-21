/**
 * scripts/visual/frame-extractor.ts: ffmpeg 抽帧.
 *
 * 三种模式 (跟 GetFramesInput.mode 对齐):
 *   - timestamp: 精确时间点 (-ss 逐个提帧)
 *   - interval: 固定间隔 (fps filter 批量)
 *   - scene: 视觉变化候选 (跟 scene-detector.ts 联动)
 *
 * 临时文件管理：
 *   - 输出到 Cache Home/frames/<video-key>/frames/
 *   - best-effort cleanup (Tool 失败时尝试清理)
 *   - TTL cleanup (下次调用清理几天前文件)
 *
 * 本文件只调 ffmpeg + 管理临时文件, 不做语义分析.
 * 视觉理解交给 Agent Vision (Claude / GPT-4V / Qwen-VL 等).
 */
import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Frame } from "../models/frame.js";
import { FrameSchema, FrameReasonSchema } from "../models/frame.js";
import { cachePaths } from "../lib/paths.js";

/** 视频 key 派生: bv + cid + quality + resolution 哈希. */
export function makeVideoKey(args: {
  bvid: string;
  cid: string;
  quality: number;
  resolution: "720p" | "1080p";
}): string {
  const h = createHash("sha1")
    .update(`${args.bvid}-${args.cid}-${args.quality}-${args.resolution}`)
    .digest("hex")
    .slice(0, 12);
  return `${args.bvid}-${args.cid}-${h}`;
}

/** 临时文件 TTL（默认 7 天，与语音转写缓存采用相同策略）。 */
export const TEMP_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ffmpeg 调用失败.
 */
export class FrameExtractionError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "FrameExtractionError";
  }
}

/**
 * ffmpeg 不在 PATH.
 */
export class FFmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegUnavailableError";
  }
}

/** ffmpeg/ffprobe PATH (测试时可覆盖). */
export interface ExtractorOptions {
  ffmpegPath?: string;
  /** 临时文件根目录. 默认使用 Cache Home. */
  tempDir?: string;
  /** 帧 jpg 质量 (q:v), 1 (最好) - 31 (最差), 默认 2. */
  jpgQuality?: number;
}

/** 实际抽帧函数签名. */
export interface ExtractTimestampsInput {
  sourcePath: string;
  videoKey: string;
  timestamps: number[];
  options?: ExtractorOptions;
}
export interface ExtractIntervalInput {
  sourcePath: string;
  videoKey: string;
  intervalSeconds: number;
  maxFrames?: number;
  options?: ExtractorOptions;
}
export interface ExtractSceneInput {
  sourcePath: string;
  videoKey: string;
  /** 最大帧数 (防止过多). */
  maxFrames?: number;
  /** scene-detector 返回的时间点 (删 score 字段). */
  sceneTimestamps: { timestampSeconds: number }[];
  options?: ExtractorOptions;
}

/**
 * mode=timestamp: 精确时间点抽帧.
 *
 * 实际 B 站下载的 mp4 是 durl 单文件, 直接 ffmpeg -ss <t> -i <src> -frames:v 1 <dst> 提帧.
 */
export async function extractTimestamps(
  input: ExtractTimestampsInput,
): Promise<Frame[]> {
  const { sourcePath, videoKey, timestamps, options } = input;
  const framesDir = await ensureFramesDir(videoKey, options?.tempDir);
  const ffmpegPath = options?.ffmpegPath ?? "ffmpeg";
  const qv = options?.jpgQuality ?? 2;

  const frames: Frame[] = [];
  for (const t of timestamps) {
    const fileName = makeFrameFileName(t, "timestamp");
    const filePath = path.join(framesDir, fileName);
    const args = [
      "-y", // 覆盖
      "-ss", t.toString(),
      "-i", sourcePath,
      "-frames:v", "1", // 提 1 帧
      "-q:v", qv.toString(),
      filePath,
    ];
    const { stderr, exitCode } = await runFfmpeg(ffmpegPath, args);
    if (exitCode !== 0) {
      throw new FrameExtractionError(
        `ffmpeg 提帧失败 (t=${t}s): ${stderr.slice(0, 300)}`,
        stderr,
        exitCode,
      );
    }
    const size = await stat(filePath).then((s) => s.size).catch(() => 0);
    const frame: Frame = FrameSchema.parse({
      id: makeFrameId(videoKey, t),
      cid: videoKey.split("-")[1] ?? "", // 简略提取
      timestampSeconds: t,
      uri: toAbsoluteFileUri(filePath),
      reason: FrameReasonSchema.enum.timestamp,
      reasonDetail: `mode=timestamp, 显式指定时间点 ${t}s`,
      // width / height 暂不查 ffprobe, 留给 Tool 入口补充
      metadata: { size, filePath },
    });
    frames.push(frame);
  }
  return frames;
}

/**
 * mode=interval: 固定间隔抽帧.
 *
 * ffmpeg -i src -vf "fps=1/intervalSeconds" -frames:v maxFrames -q:v q frame_%03d.jpg
 *
 * 注意: ffmpeg 0-based 输出编号, 我们重新算 timestampSeconds.
 */
export async function extractInterval(
  input: ExtractIntervalInput,
): Promise<Frame[]> {
  const { sourcePath, videoKey, intervalSeconds, maxFrames, options } = input;
  const framesDir = await ensureFramesDir(videoKey, options?.tempDir);
  const ffmpegPath = options?.ffmpegPath ?? "ffmpeg";
  const qv = options?.jpgQuality ?? 2;
  const cap = maxFrames ?? 50;

  // 模式: 帧文件名固定为 frame_%04d.jpg (0-based)
  const pattern = path.join(framesDir, "frame_%04d.jpg");
  const args = [
    "-y",
    "-i", sourcePath,
    "-vf", `fps=1/${intervalSeconds}`,
    "-frames:v", cap.toString(),
    "-q:v", qv.toString(),
    pattern,
  ];
  const { stderr, exitCode } = await runFfmpeg(ffmpegPath, args);
  if (exitCode !== 0) {
    throw new FrameExtractionError(
      `ffmpeg interval 抽帧失败: ${stderr.slice(0, 300)}`,
      stderr,
      exitCode,
    );
  }

  // 找实际生成的文件 (ffmpeg image2 muxer 默认 1-based, 跟 0-based 不同)
  const frames: Frame[] = [];
  for (let i = 1; i <= cap; i++) {
    const fileName = `frame_${i.toString().padStart(4, "0")}.jpg`;
    const filePath = path.join(framesDir, fileName);
    try {
      await stat(filePath);
    } catch {
      // 文件不存在 = ffmpeg 实际没生成那么多帧 (视频时长 < cap * interval)
      break;
    }
    // ffmpeg fps=1/N 第 1 帧在 t=0, 第 2 帧在 t=N, ... 第 i 帧在 t=(i-1)*N
    const t = (i - 1) * intervalSeconds;
    const frame: Frame = FrameSchema.parse({
      id: makeFrameId(videoKey, t),
      cid: videoKey.split("-")[1] ?? "",
      timestampSeconds: t,
      uri: toAbsoluteFileUri(filePath),
      reason: FrameReasonSchema.enum.interval,
      reasonDetail: `mode=interval, 每 ${intervalSeconds}s 一帧`,
      metadata: { filePath },
    });
    frames.push(frame);
  }
  return frames;
}

/**
 * mode=scene: 视觉变化候选抽帧.
 *
 * 输入是 scene-detector 返回的时间点 + score 列表 (不是直接 ffmpeg).
 * 实际抽帧用 ffmpeg -ss <t> 逐个提, 跟 timestamp 模式几乎一样, 只是 reason 不同.
 */
export async function extractScene(
  input: ExtractSceneInput,
): Promise<Frame[]> {
  const { sourcePath, videoKey, maxFrames, sceneTimestamps, options } =
    input;
  const cap = maxFrames ?? 50;

  // 算法: 用 step = N / cap (N = sceneTimestamps.length),
  //   从 N 个候选里按 (i + 0.5) * step 选 cap 个, 让它们在时间轴上均匀分布.
  // 特殊: N <= cap 时全保留.
  const filtered = sceneTimestamps.length <= cap
    ? sceneTimestamps.slice()
    : selectUniformByIndex(sceneTimestamps, cap);
  if (filtered.length === 0) {
    return [];
  }
  const baseOptions: ExtractorOptions = options ?? {};
  const baseFramesDir = baseOptions.tempDir
    ? path.join(baseOptions.tempDir, videoKey, "frames")
    : path.join(cachePaths.frames(), videoKey, "frames");
  await mkdir(baseFramesDir, { recursive: true });
  const ffmpegPath = baseOptions.ffmpegPath ?? "ffmpeg";
  const qv = baseOptions.jpgQuality ?? 2;

  const frames: Frame[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    if (!item) continue;
    const t = item.timestampSeconds;
    const fileName = makeFrameFileName(t, "scene");
    const filePath = path.join(baseFramesDir, fileName);
    const args = [
      "-y",
      "-ss", t.toString(),
      "-i", sourcePath,
      "-frames:v", "1",
      "-q:v", qv.toString(),
      filePath,
    ];
    const { stderr, exitCode } = await runFfmpeg(ffmpegPath, args);
    if (exitCode !== 0) {
      throw new FrameExtractionError(
        `ffmpeg 提 scene 帧失败 (t=${t}s): ${stderr.slice(0, 300)}`,
        stderr,
        exitCode,
      );
    }
    const frame: Frame = FrameSchema.parse({
      id: makeFrameId(videoKey, t),
      cid: videoKey.split("-")[1] ?? "",
      timestampSeconds: t,
      uri: toAbsoluteFileUri(filePath),
      reason: FrameReasonSchema.enum.scene_change,
      reasonDetail: `mode=scene, 通过 threshold 过滤后保留的视觉变化候选`,
      metadata: { filePath },
    });
    frames.push(frame);
  }
  return frames;
}

/**
 * best-effort cleanup 临时帧目录.
 * Tool 调用失败时调用, 避免磁盘堆积.
 */
export async function cleanupVideoTemp(
  videoKey: string,
  tempDir = cachePaths.frames(),
): Promise<void> {
  const dir = path.join(tempDir, videoKey);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort, 失败不抛
  }
}

/**
 * TTL cleanup: 清理超过 TTL 的旧视频临时目录.
 * Tool 入口下次调用时跑.
 */
export async function cleanupExpiredTemp(
  tempDir = cachePaths.frames(),
  ttlMs = TEMP_FILE_TTL_MS,
): Promise<{ cleaned: number }> {
  const root = tempDir;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await (await import("node:fs/promises")).readdir(root, {
      withFileTypes: true,
    });
  } catch {
    return { cleaned: 0 }; // 目录不存在
  }

  const now = Date.now();
  let cleaned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    try {
      const stats = await stat(dirPath);
      if (now - stats.mtimeMs > ttlMs) {
        await rm(dirPath, { recursive: true, force: true });
        cleaned += 1;
      }
    } catch {
      // 跳过
    }
  }
  return { cleaned };
}

// === 内部 helper ===

/**
 * 时间秒 → 文件名后缀毫秒字符串 (例: 10.1 → "000010100").
 * 改用整数毫秒 (t*1000 取整) → 至少 7 位, 避免冲突.
 */
function timeToMillisString(t: number): string {
  const ms = Math.round(t * 1000);
  return ms.toString().padStart(7, "0");
}

function makeFrameFileName(t: number, mode: string): string {
  return `f-${mode}-${timeToMillisString(t)}.jpg`;
}

function makeFrameId(videoKey: string, t: number): string {
  return `F-${videoKey}-${timeToMillisString(t)}`;
}

/**
 * 本地文件路径 → 标准 file URI ().
 *
 * 旧版用 `file://${filePath}` 拼相对路径, 跨进程会找不到.
 * 现用 path.resolve 拿绝对路径 + pathToFileURL 转标准 URI, 任何 Agent 都能打开.
 *
 * 重要: 这里保留 caller 传入的 path.resolve (避免覆盖 tempDir 跟 cwd 的相对逻辑).
 */
export function toAbsoluteFileUri(filePath: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  return pathToFileURL(absolute).href;
}

async function ensureFramesDir(
  videoKey: string,
  tempDir?: string,
): Promise<string> {
  const dir = tempDir
    ? path.join(tempDir, videoKey, "frames")
    : path.join(cachePaths.frames(), videoKey, "frames");
  await mkdir(dir, { recursive: true });
  return dir;
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf-8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new FFmpegUnavailableError(`ffmpeg 不可用: ${ffmpegPath}`));
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * 从 N 个候选里选 k 个, 使 k 个在数组索引上尽量均匀.
 *
 * 选法: 用 (i + 0.5) * (N / k) 索引公式 (centered sampling),
 *   保证第 0 个和第 N-1 个都被覆盖, 中间 k 个均匀分布.
 *
 * 前提: sceneTimestamps 已按 timestampSeconds 升序 (ffmpeg scene filter
 *   输出天然升序). 数组索引均匀 ≈ 时间轴均匀 (因为 ffmpeg 不保证等间隔,
 *   但对 representative selection 已够).
 */
function selectUniformByIndex<T>(arr: readonly T[], k: number): T[] {
  const n = arr.length;
  if (k >= n) return arr.slice();
  const result: T[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.min(n - 1, Math.floor((i + 0.5) * (n / k)));
    const item = arr[idx];
    if (item !== undefined) result.push(item);
  }
  return result;
}
