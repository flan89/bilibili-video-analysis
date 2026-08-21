/**
 * scripts/visual/dash-concat.ts: B 站 DASH m4s 拼装 helper (M5.1 备用).
 *
 * 背景 (来自 M5 GPT 评审 + P0-1 实际验证):
 *   - B 站 playurl 返 DASH 模式时, dash.video[i].baseUrl 是首个分片 m4s URL (带 Initialization 头)
 *   - 但 ffmpeg 单个 m4s segment 不能 seek 跨 segment, 提帧可能不准确
 *   - 解决: 拼 init 段 (segment_base.Initialization, base64 encoded) + dash segment = 完整可 seek mp4
 *
 * 实测 (2026-08-19, P0-1 验证):
 *   - 4 个 modern 视频匿名访问全部返 durl 单文件, 拿不到 DASH response
 *   - 因为匿名 qn<=64, 而 DASH 通常需要 qn>=80 + 登录态
 *   - 所以 M5.1 默认 qn=64 走 durl 路径, DASH helper 仅在 qn=80 触发时使用
 *
 * D12 边界: 本文件只处理 m4s 拼装机制, 不混入业务逻辑.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 拼装错误. */
export class DashConcatError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "DashConcatError";
  }
}

/** ffmpeg 不在 PATH. */
export class FfmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegUnavailableError";
  }
}

/**
 * 拼装 B 站 DASH 视频分片: init 段 (base64) + 主分片 m4s.
 * 输出是完整可 seek 的 mp4 容器 (B 站 m4s init 已含 ftyp + moov box).
 *
 * @param initBase64 B 站 dash.video[i].segment_base.Initialization (base64 string)
 * @param segmentPath 已下载到本地的 m4s segment 路径
 * @param outputPath 输出 mp4 路径
 * @param ffmpegPath ffmpeg 路径 (默认 "ffmpeg")
 */
export async function concatDashSegment(
  initBase64: string,
  segmentPath: string,
  outputPath: string,
  ffmpegPath = "ffmpeg",
): Promise<{ size: number }> {
  // 1) 写 init 段到临时文件
  const initPath = `${outputPath}.init.m4s`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(initPath, Buffer.from(initBase64, "base64"));

  // 2) 写 concat list (ffmpeg concat demuxer)
  const concatListPath = `${outputPath}.concat.txt`;
  await writeFile(concatListPath, `file '${initPath}'\nfile '${segmentPath}'\n`);

  // 3) ffmpeg concat
  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy", // 不转码, 直接复制 m4s 字节
    outputPath,
  ];
  const { stderr, exitCode } = await runFfmpeg(ffmpegPath, args);
  if (exitCode !== 0) {
    throw new DashConcatError(
      `ffmpeg concat 失败: ${stderr.slice(0, 300)}`,
      stderr,
      exitCode,
    );
  }
  return { size: 0 }; // caller 可用 stat 拿
}

/**
 * 下载 DASH segment + 拼装成完整 mp4.
 *
 * @param dashBaseUrl dash.video[i].baseUrl (m4s URL)
 * @param initBase64 dash.video[i].segment_base.Initialization
 * @param outputPath 输出完整 mp4 路径
 * @param fetchImpl fetch 实现 (测试可注入)
 * @param headers 额外 HTTP 头 (User-Agent / Referer / Cookie)
 * @param ffmpegPath ffmpeg 路径
 */
export async function downloadAndConcatDash(
  dashBaseUrl: string,
  initBase64: string,
  outputPath: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  ffmpegPath = "ffmpeg",
): Promise<{ size: number }> {
  // 1) 下载 segment
  const response = await fetchImpl(dashBaseUrl, { headers });
  if (!response.ok) {
    throw new DashConcatError(
      `DASH segment 下载失败 HTTP ${response.status}`,
      "",
      response.status,
    );
  }
  if (!response.body) {
    throw new DashConcatError("DASH segment 响应无 body", "", -1);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const segPath = `${outputPath}.seg.m4s`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(segPath, buffer);

  // 2) 拼装
  const { size: _size } = await concatDashSegment(initBase64, segPath, outputPath, ffmpegPath);
  // 注: 实际 size 由 caller stat 输出文件拿
  return { size: buffer.byteLength };
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf-8")));
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new FfmpegUnavailableError(`ffmpeg 不可用: ${ffmpegPath}`));
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

// 兼容旧引用: 复用 join
export { join };
