/**
 * scripts/visual/get.ts: `bilibili.get_frames` Tool 入口.
 *
 * M5.1 视觉 Acquisition. 单 Tool 三 mode:
 *   - timestamp: 精确时间点列表
 *   - interval:  固定时间间隔 + maxFrames
 *   - scene:     ffmpeg scene-change score 阈值 + maxFrames
 *
 * 内部流程:
 *   resolve video → metadata → select page → resolvePlayUrl (qn=64 默认)
 *     → durl or complete DASH m4s download
 *     → ffprobe duration
 *     → 按 mode 调 frame-extractor (或先调 scene-detector)
 *     → 返回 FrameSet (含 visualChanges 完整时间轴)
 *
 * 设计原则 (D08/D12/D23/D24/D25):
 * - 无状态: 每次调用独立, 不共享任何"VideoAsset"
 * - 原子 Tool: 内部完成整链, 一次性返回
 * - 外部协议隔离: B 站 playurl 字段不暴露到 Tool 输出
 * - 失败结构化: reasonCode 表达失败原因, 不抛业务异常
 * - 临时状态不外泄: 视频下载 + 帧文件放 Cache Home, 失败 best-effort cleanup
 * - Tool 内部不调第二套模型 (D23): 不做视觉理解, Agent 自己读 jpg
 *
 * 跨 Agent 契约 (M5.0 Feasibility 结论):
 *   - Tool 返回的每帧含本地绝对路径 fileURI (`file:///absolute/path/...`)
 *   - 不假设 Agent 客户端支持 Tool attachment / image resource
 *   - Agent 自己读本地 jpg (本机 / sandbox 申请权限)
 */
import { VideoRefSchema } from "../models/video.js";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { BilibiliClient, type BilibiliSubtitleClient } from "../bilibili/client.js";
import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import { WbiSigner } from "../bilibili/wbi.js";
import {
  QualityCode,
  resolvePlayUrl,
  type VideoStreamInfo,
} from "../bilibili/playurl.js";
import { getBilibiliMetadata } from "../metadata/get.js";
import {
  VideoMetadataSchema,
  VideoPageSchema,
  type VideoMetadata,
} from "../metadata/model.js";
import { AcquisitionRecordSchema, type AcquisitionRecord, type AcquisitionState } from "../models/index.js";
import {
  GetFramesInputSchema,
  GetFramesOutputSchema,
  FramesReasonCode,
  type FrameSet,
  type GetFramesInput,
  type GetFramesOutput,
  type FrameExtractionMode,
  type VisualChange,
} from "./model.js";
import {
  cleanupExpiredTemp,
  cleanupVideoTemp,
  extractInterval,
  extractScene,
  extractTimestamps,
  FFmpegUnavailableError,
  FrameExtractionError,
  makeVideoKey,
  TEMP_FILE_TTL_MS,
} from "./frame-extractor.js";
import { detectVisualChanges, SceneDetectionError } from "./scene-detector.js";
import { probeMedia } from "./media-probe.js";
import { cachePaths } from "../lib/paths.js";
import { makeSetupHint } from "../lib/setup-hint.js";

// ---------------------------------------------------------------------------
// Page selection (跟 danmaku/get.ts 的 selectPage 同形, 但 M5 Tool 不复用
// 是因为 M3 弹幕依赖的 pageChoice schema 跟 M5 不完全一样. 抄过来避免
// 跨能力域耦合. 后续若 M1 page selection 抽到 models, 再统一.
// ---------------------------------------------------------------------------

interface PageSelectionSuccess { kind: "selected"; cid: string }
interface PageSelectionRequired { kind: "selection_required" }
interface PageSelectionFailed { kind: "failed"; error: BilibiliError }
type PageSelection = PageSelectionSuccess | PageSelectionRequired | PageSelectionFailed;

function selectPage(
  metadata: VideoMetadata,
  explicitCid: string | undefined,
  requestedPage: number | undefined,
): PageSelection {
  const pages = metadata.pages;

  if (explicitCid !== undefined) {
    const matched = pages.find((p) => p.cid === explicitCid);
    if (!matched) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_cid",
          message: `cid=${explicitCid} 不属于当前视频的分P列表`,
        }),
      };
    }
    if (requestedPage !== undefined && matched.page !== requestedPage) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "conflicting_page_selection",
          message: `cid=${explicitCid} 对应第 ${matched.page}P, 与指定的第 ${requestedPage}P 不一致`,
        }),
      };
    }
    return { kind: "selected", cid: matched.cid };
  }

  if (requestedPage !== undefined) {
    const matched = pages.find((p) => p.page === requestedPage);
    if (!matched) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_page",
          message: `第 ${requestedPage}P 不属于当前视频, 可选范围为 1-${pages.length}`,
        }),
      };
    }
    return { kind: "selected", cid: matched.cid };
  }

  if (pages.length === 1 && pages[0]) {
    return { kind: "selected", cid: pages[0].cid };
  }
  if (pages.length > 1) {
    return { kind: "selection_required" };
  }
  return {
    kind: "failed",
    error: new BilibiliError({
      code: "cid_unavailable",
      message: "视频元信息没有可用于拉取视频流的 cid",
    }),
  };
}

// ---------------------------------------------------------------------------
// 工具: 从 playurl output 选 quality (考虑实际 acceptQuality)
// ---------------------------------------------------------------------------

function pickQuality(stream: VideoStreamInfo, resolution: "720p" | "1080p"): number {
  const preferred = resolution === "1080p" ? QualityCode.full_hd : QualityCode.hd;
  const accepted = stream.acceptQuality;
  if (accepted.length === 0) return stream.quality;
  if (accepted.includes(preferred)) return preferred;
  // fallback: 选 <= preferred 中最大的 (避免拉到 4K 占带宽)
  const lower = accepted.filter((q) => q <= preferred).sort((a, b) => b - a);
  if (lower.length > 0 && lower[0] !== undefined) return lower[0];
  // 否则选 accepted 中最小的 (避免拿 4K)
  return accepted.sort((a, b) => a - b)[0] ?? stream.quality;
}

// ---------------------------------------------------------------------------
// 工具: streaming download + timeout
// ---------------------------------------------------------------------------

interface DownloadOptions {
  url: string;
  destPath: string;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  timeoutMs: number;
  onProgress?: (downloadedBytes: number) => void;
}

/**
 * 流式下载 URL 到本地文件.
 *
 * 用 Readable.fromWeb + createWriteStream 边下边写, 不全量进内存.
 * AbortController 提供 timeout, 长视频不会让 Tool 长时间挂起.
 */
async function downloadToFileStream(opts: DownloadOptions): Promise<{ size: number }> {
  const { url, destPath, fetchImpl, headers, timeoutMs, onProgress } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === "AbortError") {
      throw new BilibiliError({
        code: "playurl_http_error",
        message: `下载视频源超时 (${timeoutMs}ms)`,
        retryable: true,
      });
    }
    throw new BilibiliError({
      code: "playurl_http_error",
      message: `下载视频源网络错误: ${(e as Error).message}`,
      retryable: true,
      cause: e,
    });
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw new BilibiliError({
      code: "playurl_http_error",
      message: `下载视频源 HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new BilibiliError({
      code: "playurl_http_error",
      message: "下载视频源响应没有 body",
      retryable: true,
    });
  }

  await mkdir(dirname(destPath), { recursive: true });
  const file = createWriteStream(destPath);

  let totalBytes = 0;
  try {
    // Node 18+ Readable.fromWeb 支持 Web ReadableStream
    const nodeStream = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
    for await (const chunk of nodeStream) {
      const buf = chunk as Buffer;
      totalBytes += buf.byteLength;
      if (!file.write(buf)) {
        // 背压: 等待 drain
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
      onProgress?.(totalBytes);
      // 检查是否已被 abort
      if (controller.signal.aborted) {
        file.destroy();
        throw new BilibiliError({
          code: "playurl_http_error",
          message: `下载视频源超时 (${timeoutMs}ms)`,
          retryable: true,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } finally {
    clearTimeout(timer);
  }
  return { size: totalBytes };
}

// ---------------------------------------------------------------------------
// Tool 入口
// ---------------------------------------------------------------------------

/** 依赖注入 (单测 + 真实网络用同一入口). */
export interface GetFramesDependencies {
  client?: BilibiliSubtitleClient;
  signer?: WbiSigner;
  cookie?: string;
  fetchImpl?: typeof fetch;
  /** ffmpeg/ffprobe 路径覆盖 (测试用). */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 临时目录覆盖 (测试用). 默认使用 Cache Home，不写 Skill 安装目录。 */
  tempDir?: string;
  /** 跳过 TTL cleanup (单测用). */
  skipTempCleanup?: boolean;
  /** 下载超时 (ms), 默认 120000 (2 分钟). */
  downloadTimeoutMs?: number;
}

/** 视频源下载结果. */
interface DownloadedSource {
  sourcePath: string;
  sizeBytes: number;
  /** "durl" 单文件 mp4, "dash" 拼装后 mp4. */
  kind: "durl" | "dash";
  /** 真实 quality 码 (可能因 B 站降级跟 requested 不同). */
  actualQuality: number;
}

/**
 * `bilibili.get_frames` Tool 入口.
 *
 * 不抛业务异常. 任何失败都通过 `outcome: "failed"` + `reasonCode` 表达.
 */
export async function getBilibiliFrames(
  rawInput: GetFramesInput,
  dependencies: GetFramesDependencies = {},
): Promise<GetFramesOutput> {
  const input = GetFramesInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const signer = dependencies.signer ?? new WbiSigner({ cookie: dependencies.cookie });
  const fetchImpl =
    dependencies.fetchImpl
    ?? (client as { fetchImpl?: typeof fetch }).fetchImpl
    ?? fetch;
  const userAgent =
    (client as { userAgent?: string }).userAgent
    ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
  const tempDir = dependencies.tempDir ?? cachePaths.frames();
  const downloadTimeoutMs = dependencies.downloadTimeoutMs
    ?? input.downloadTimeoutMs
    ?? 120_000;
  const requestedAt = new Date().toISOString();

  // 0) TTL cleanup (await, 避免跟 download 并发 race)
  if (!dependencies.skipTempCleanup) {
    try {
      await cleanupExpiredTemp(tempDir, TEMP_FILE_TTL_MS);
    } catch {
      // 静默, 不影响主流程
    }
  }

  // 1) 解析 video
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    return fail({
      videoUrl: input.video,
      requestedAt,
      reasonCode: toBilibiliError(error).code,
      message: `解析视频输入失败: ${toBilibiliError(error).message}`,
      retryable: toBilibiliError(error).retryable,
    });
  }

  // 2) 合并分P选择
  if (
    input.page !== undefined
    && resolvedInput.requestedPage !== undefined
    && input.page !== resolvedInput.requestedPage
  ) {
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      requestedAt,
      reasonCode: FramesReasonCode.conflicting_page_selection,
      message: `命令指定第 ${input.page}P, 但视频 URL 指定第 ${resolvedInput.requestedPage}P`,
    });
  }

  const requestedPage = input.page ?? resolvedInput.requestedPage;

  // 3) 拿 metadata
  const metadataResult = await getBilibiliMetadata(
    { video: resolvedInput.canonicalUrl, includeTags: false },
    { client },
  );

  if (!metadataResult.success || !metadataResult.metadata || !metadataResult.video) {
    const metadataError = metadataResult.error;
    const message = metadataError
      ? `获取帧所需视频信息失败: ${metadataError.message}`
      : "获取帧所需视频信息失败";
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      requestedAt,
      reasonCode: metadataError?.code ?? FramesReasonCode.metadata_prerequisite_failed,
      message,
      retryable: metadataError?.retryable ?? false,
    });
  }

  const metadata: VideoMetadata = VideoMetadataSchema.parse(metadataResult.metadata);
  const aid = metadata.aid;
  if (!aid) {
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      requestedAt,
      reasonCode: FramesReasonCode.aid_unavailable,
      message: "视频元信息缺少视频流接口所需的 aid",
    });
  }

  // 4) 选分P
  const pageChoice = selectPage(metadata, input.cid, requestedPage);
  if (pageChoice.kind === "selection_required") {
    return GetFramesOutputSchema.parse({
      success: false,
      outcome: "selection_required",
      video: VideoRefSchema.parse({ bvid: metadata.bvid }),
      pageChoices: metadata.pages.map((p) =>
        VideoPageSchema.pick({
          page: true,
          cid: true,
          title: true,
          durationSeconds: true,
        }).parse(p),
      ),
      acquisition: makeAcquisition({
        status: "not_requested",
        source: "bilibili_player_api",
        requestedAt,
        // selection_required 不是失败, 但抽帧还没发起, Agent 拿 status 决定是否提供 pageChoices
        message: "多P视频尚未选择目标分P, 抽帧未发起",
        metadata: { bvid: metadata.bvid, phase: "page_selection" },
      }),
    });
  }
  if (pageChoice.kind === "failed") {
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      requestedAt,
      reasonCode: pageChoice.error.code,
      message: pageChoice.error.message,
      retryable: pageChoice.error.retryable,
    });
  }
  const cid = pageChoice.cid;

  // 5) resolvePlayUrl 拿视频流
  const requestedQuality = input.resolution === "1080p" ? QualityCode.full_hd : QualityCode.hd;
  let stream: VideoStreamInfo;
  try {
    stream = await resolvePlayUrl(
      client,
      {
        aid: Number(aid),
        cid: Number(cid),
        quality: requestedQuality,
        dash: true,
        fetchImpl,
        cookie: dependencies.cookie,
      },
      signer,
    );
  } catch (error) {
    const normalized = toBilibiliError(error);
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      cid,
      requestedAt,
      reasonCode: FramesReasonCode.playurl_prerequisite_failed,
      message: `playurl 失败: ${normalized.message}`,
      retryable: normalized.retryable,
    });
  }

  // 6) 选最终 quality (考虑实际 acceptQuality)
  const finalQuality = pickQuality(stream, input.resolution);
  if (finalQuality !== stream.quality) {
    try {
      stream = await resolvePlayUrl(
        client,
        {
          aid: Number(aid),
          cid: Number(cid),
          quality: finalQuality,
          dash: true,
          fetchImpl,
          cookie: dependencies.cookie,
        },
        signer,
      );
    } catch (error) {
      const normalized = toBilibiliError(error);
      return fail({
        videoUrl: resolvedInput.canonicalUrl,
        bvid: metadata.bvid,
        cid,
        requestedAt,
        reasonCode: FramesReasonCode.playurl_prerequisite_failed,
        message: `playurl 二次重试失败 (quality=${finalQuality}): ${normalized.message}`,
        retryable: normalized.retryable,
      });
    }
  }
  const qualityWarning = stream.quality < requestedQuality
    ? `请求 ${input.resolution}（清晰度代码 ${requestedQuality}），但平台实际返回代码 ${stream.quality}；视觉证据已降级`
    : undefined;

  // 7) 准备 download headers
  const downloadHeaders: Record<string, string> = {
    "User-Agent": userAgent,
    "Referer": "https://www.bilibili.com",
    ...(dependencies.cookie ? { cookie: dependencies.cookie } : {}),
  };

  // 8) 准备临时目录
  const videoKey = makeVideoKey({
    bvid: metadata.bvid,
    cid,
    quality: stream.quality,
    resolution: input.resolution,
  });
  const sourcePath = join(tempDir, videoKey, "source.mp4");

  // 9) Download one complete media source: durl first, then DASH m4s.
  let downloaded: DownloadedSource;
  try {
    downloaded = await downloadVideoSource({
      stream,
      sourcePath,
      fetchImpl,
      headers: downloadHeaders,
      timeoutMs: downloadTimeoutMs,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      cid,
      requestedAt,
      reasonCode: FramesReasonCode.playurl_prerequisite_failed,
      message: `下载视频源失败: ${normalized.message}`,
      retryable: normalized.retryable,
      videoKey,
    });
  }

  // 10) ffprobe 拿 duration
  let targetDurationSeconds: number;
  try {
    const probe = await probeMedia(downloaded.sourcePath, dependencies.ffprobePath);
    targetDurationSeconds = probe.durationSeconds;
  } catch (error) {
    await cleanupVideoTemp(videoKey, tempDir);
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      cid,
      requestedAt,
      reasonCode: FramesReasonCode.frame_extraction_failed,
      message: `ffprobe 拿时长失败: ${(error as Error).message}`,
      videoKey,
    });
  }

  // Compare downloaded DASH duration with the selected page duration from metadata.
  // A meaningful shortage remains partial and makes coverage.complete=false.
  let mediaDurationShortageRatio: number | undefined;  // 1.0 = 100% 完整, < 1.0 = 缺
  let mediaCoverageWarning: string | undefined;
  const selectedPage = metadata.pages.find((p) => p.cid === cid);
  const expectedDurationSeconds = selectedPage?.durationSeconds;
  if (
    downloaded.kind === "dash" &&
    expectedDurationSeconds !== undefined &&
    expectedDurationSeconds > 0
  ) {
    mediaDurationShortageRatio = targetDurationSeconds / expectedDurationSeconds;
    if (mediaDurationShortageRatio < 0.95) {
      // 缺超过 5% → 标 partial + warning
      mediaCoverageWarning =
        `DASH 媒体时长 ${targetDurationSeconds.toFixed(1)} 秒，低于视频分P时长 ${expectedDurationSeconds.toFixed(1)} 秒` +
        `（实际覆盖约 ${(mediaDurationShortageRatio * 100).toFixed(1)}%）。` +
        `视觉证据可能只覆盖前 ${(mediaDurationShortageRatio * 100).toFixed(0)}%，不能据此形成全片结论`;
    }
  }

  // 11) 计算 plan
  const plan = computePlan(input, targetDurationSeconds);

  // 12) 按 mode 调 frame-extractor (或先调 scene-detector)
  const extractorOptions = {
    ffmpegPath: dependencies.ffmpegPath,
    tempDir,
    jpgQuality: 2,
  };

  let frames: import("../models/frame.js").Frame[];
  let visualChanges: VisualChange[] | undefined;
  let visualChangesTotal: number | undefined;
  let visualChangesTruncated: boolean | undefined;
  try {
    const result = await runExtraction({
      mode: input.mode,
      sourcePath: downloaded.sourcePath,
      videoKey,
      input,
      plan,
      options: extractorOptions,
    });
    frames = result.frames;
    visualChanges = result.visualChanges;
    visualChangesTotal = result.visualChangesTotal;
    visualChangesTruncated = result.visualChangesTruncated;
  } catch (error) {
    await cleanupVideoTemp(videoKey, tempDir);
    if (error instanceof FFmpegUnavailableError) {
      return fail({
        videoUrl: resolvedInput.canonicalUrl,
        bvid: metadata.bvid,
        cid,
        requestedAt,
        reasonCode: FramesReasonCode.ffmpeg_unavailable,
        message: error.message,
        videoKey,
      });
    }
    if (error instanceof SceneDetectionError) {
      return fail({
        videoUrl: resolvedInput.canonicalUrl,
        bvid: metadata.bvid,
        cid,
        requestedAt,
        reasonCode: FramesReasonCode.scene_detection_failed,
        message: error.message,
        videoKey,
      });
    }
    if (error instanceof FrameExtractionError) {
      return fail({
        videoUrl: resolvedInput.canonicalUrl,
        bvid: metadata.bvid,
        cid,
        requestedAt,
        reasonCode: FramesReasonCode.frame_extraction_failed,
        message: error.message,
        videoKey,
      });
    }
    return fail({
      videoUrl: resolvedInput.canonicalUrl,
      bvid: metadata.bvid,
      cid,
      requestedAt,
      reasonCode: FramesReasonCode.unexpected_error,
      message: (error as Error).message,
      videoKey,
    });
  }

  // 13) 补 width/height 字段
  if (frames.length > 0) {
    try {
      const probe = await probeMedia(downloaded.sourcePath, dependencies.ffprobePath);
      const w = probe.video?.width;
      const h = probe.video?.height;
      if (w && h) {
        for (const f of frames) {
          if (f.width === undefined) f.width = w;
          if (f.height === undefined) f.height = h;
        }
      }
    } catch {
      // 静默, width/height 留空
    }
  }

  // 14) 构建 FrameSet + Acquisition
  const buildResult = buildCoverageAndAcquisition({
    mode: input.mode,
    frames,
    plan,
    targetDurationSeconds,
    visualChanges,
    rawTimestamps: input.timestamps,
    visualChangesTruncated,
    visualChangesTotal,
    sceneThreshold: input.sceneThreshold,
  });
  let { coverage } = buildResult;
  let { warnings } = buildResult;
  let { acquisitionStatus } = buildResult;

  if (qualityWarning) {
    warnings.push(qualityWarning);
    if (acquisitionStatus === "success") acquisitionStatus = "partial";
  }

  // DASH 媒体时长不达标时, 显式 partial + 警告 + 暴露覆盖率
  if (mediaCoverageWarning) {
    warnings.push(mediaCoverageWarning);
    // 强制降级: 哪怕 plan 全跑完, 媒体不全也不能说 Coverage 完整
    if (acquisitionStatus === "success") {
      acquisitionStatus = "partial";
    }
    coverage = {
      ...coverage,
      complete: false,
      targetDurationSeconds: expectedDurationSeconds ?? coverage.targetDurationSeconds,
      // 把"真实覆盖率"显式写入 coverage, Agent 直接读这个字段判断
      mediaDurationShortageRatio,
      expectedDurationSeconds,
    };
  }

  const frameset: FrameSet = {
    video: { bvid: metadata.bvid, cid },
    mode: input.mode,
    frames,
    coverage,
    visualChanges,
    visualChangesTotal,
    visualChangesTruncated,
    acquisition: makeAcquisition({
      status: acquisitionStatus,
      source: "bilibili_player_api",
      requestedAt,
      itemCount: frames.length,
      warnings,
      message: warnings.length > 0
        ? `抽帧完成, 共 ${frames.length} 帧, 含 ${warnings.length} 条警告`
        : `抽帧完成, 共 ${frames.length} 帧`,
      metadata: {
        bvid: metadata.bvid,
        cid,
        quality: stream.quality,
        requestedQuality,
        resolution: input.resolution,
        kind: downloaded.kind,
        sourceBytes: downloaded.sizeBytes,
        mode: input.mode,
        planRequestedCount: plan.requestedFrameCount,
      },
    }),
    warnings,
    metadata: {
      ffmpeg: dependencies.ffmpegPath ?? "ffmpeg",
      videoKey,
      streamInfo: {
        quality: stream.quality,
        acceptQuality: stream.acceptQuality,
        width: stream.videoWidth,
        height: stream.videoHeight,
        mimeType: stream.videoMimeType,
      },
    },
  };

  return GetFramesOutputSchema.parse({
    success: true,
    outcome: "success",
    video: { bvid: metadata.bvid, cid },
    frameset,
    acquisition: frameset.acquisition,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** plan 信息: 计划 / 请求 / 实际抽到. */
interface PlanInfo {
  plannedFrameCount: number;
  requestedFrameCount: number;
  /** maxFrames 是否截断 plan. */
  truncated: boolean;
}

/** mode=timestamp: 排重 + 排序. mode=interval: ceil(dur / interval). mode=scene: maxFrames. */
function computePlan(input: GetFramesInput, targetDurationSeconds: number): PlanInfo {
  // maxFrames 有 schema default(50), 但 z.input 类型仍是 optional, 这里 fallback
  const maxFrames = input.maxFrames ?? 50;
  if (input.mode === "timestamp") {
    const sortedUnique = Array.from(new Set(input.timestamps ?? []))
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);
    return {
      plannedFrameCount: sortedUnique.length,
      requestedFrameCount: sortedUnique.length,
      truncated: false,
    };
  }
  if (input.mode === "interval") {
    const interval = input.intervalSeconds!;
    const planned = Math.max(1, Math.ceil(targetDurationSeconds / interval));
    const requested = Math.min(planned, maxFrames);
    return {
      plannedFrameCount: planned,
      requestedFrameCount: requested,
      truncated: planned > maxFrames,
    };
  }
  // scene 模式 "计划" = "扫整片 + 均匀选 maxFrames", 不是
  // "计划抽 maxFrames" (旧版 plannedFrameCount=maxFrames 跟实际 plan 不符).
  // 改为 0 (schema optional) 让 coverage.plannedFrameCount 不会被错误解读.
  return {
    plannedFrameCount: 0,
    requestedFrameCount: maxFrames,
    truncated: false,
  };
}

interface DownloadSourceArgs {
  stream: VideoStreamInfo;
  sourcePath: string;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  timeoutMs: number;
}

async function downloadVideoSource(args: DownloadSourceArgs): Promise<DownloadedSource> {
  const { stream, sourcePath, fetchImpl, headers, timeoutMs } = args;

  // 优先 durl 单文件 (老视频 / 匿名 720P)
  if (stream.durlUrls && stream.durlUrls.length === 1 && stream.durlUrls[0]) {
    const url = stream.durlUrls[0];
    const { size } = await downloadToFileStream({
      url,
      destPath: sourcePath,
      fetchImpl,
      headers,
      timeoutMs,
    });
    return { sourcePath, sizeBytes: size, kind: "durl", actualQuality: stream.quality };
  }

  if (stream.durlUrls && stream.durlUrls.length > 1) {
    throw new BilibiliError({
      code: "playurl_no_video_stream",
      message: `durl 多 fragment (${stream.durlUrls.length} 段) 暂不支持拼装, M5.1a 仅支持单文件 durl`,
      retryable: false,
    });
  }

  // DASH baseUrl points to the complete m4s media file; SegmentBase fields are byte ranges.
  if ((!stream.durlUrls || stream.durlUrls.length === 0) && stream.videoBaseUrl) {
    const { size } = await downloadToFileStream({
      url: stream.videoBaseUrl,
      destPath: sourcePath,
      fetchImpl,
      headers,
      timeoutMs,
    });
    return { sourcePath, sizeBytes: size, kind: "dash", actualQuality: stream.quality };
  }

  throw new BilibiliError({
    code: "playurl_no_video_stream",
    message: "playurl 既没有 durl 也没有 DASH 视频流",
  });
}

interface RunExtractionArgs {
  mode: FrameExtractionMode;
  sourcePath: string;
  videoKey: string;
  input: GetFramesInput;
  plan: PlanInfo;
  options: { ffmpegPath?: string; tempDir: string; jpgQuality?: number };
}

interface ExtractionResult {
  frames: import("../models/frame.js").Frame[];
  visualChanges?: VisualChange[];
  /** visualChanges 实际检测到总数 (scene mode). */
  visualChangesTotal?: number;
  /** visualChanges 是否被 maxCandidates 内存保护截断 (scene mode). */
  visualChangesTruncated?: boolean;
}

async function runExtraction(args: RunExtractionArgs): Promise<ExtractionResult> {
  const { mode, sourcePath, videoKey, input, plan, options } = args;

  if (mode === "timestamp") {
    // 已 sort+dedupe 过的 timestamps
    const sortedUnique = Array.from(new Set(input.timestamps ?? []))
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);
    const frames = await extractTimestamps({
      sourcePath,
      videoKey,
      timestamps: sortedUnique,
      options,
    });
    return { frames, visualChanges: undefined };
  }

  if (mode === "interval") {
    if (input.intervalSeconds === undefined) {
      throw new BilibiliError({
        code: "frame_extraction_failed",
        message: "mode=interval 必须提供 intervalSeconds",
      });
    }
    const frames = await extractInterval({
      sourcePath,
      videoKey,
      intervalSeconds: input.intervalSeconds,
      maxFrames: plan.requestedFrameCount,
      options,
    });
    return { frames, visualChanges: undefined };
  }

  if (mode === "scene") {
    const sceneResult = await detectVisualChanges(sourcePath, {
      ffmpegPath: options.ffmpegPath,
      threshold: input.sceneThreshold,
    });
    const candidates = sceneResult.candidates;
    // 抽 maxFrames 张代表 (从全时间轴均匀选, 不是 slice(0, cap))
    const frames = await extractScene({
      sourcePath,
      videoKey,
      maxFrames: plan.requestedFrameCount,
      sceneTimestamps: candidates,
      options,
    });
    // visualChanges = 完整候选时间轴 (真实全量 + truncated 状态)
    const visualChanges: VisualChange[] = candidates.map((c) => ({
      timestampSeconds: c.timestampSeconds,
    }));
    return {
      frames,
      visualChanges,
      visualChangesTotal: sceneResult.totalDetected,
      visualChangesTruncated: sceneResult.truncated,
    };
  }

  throw new BilibiliError({
    code: "frame_extraction_failed",
    message: `未知 mode: ${mode}`,
  });
}

interface BuildCoverageArgs {
  mode: FrameExtractionMode;
  frames: import("../models/frame.js").Frame[];
  plan: PlanInfo;
  targetDurationSeconds: number;
  visualChanges?: VisualChange[];
  /** mode=timestamp 用: 原始用户输入的 timestamps (用于检测越界). */
  rawTimestamps?: number[];
  /** visualChanges 是否被 maxCandidates 截断 (scene mode). */
  visualChangesTruncated?: boolean;
  /** visualChanges 实际检测到的总数 (scene mode). */
  visualChangesTotal?: number;
  /** 用户传的 scene threshold, 0 candidate warning 用真实值不写死. */
  sceneThreshold?: number;
}

interface BuildCoverageResult {
  coverage: FrameSet["coverage"];
  warnings: string[];
  acquisitionStatus: "success" | "partial";
}

function buildCoverageAndAcquisition(args: BuildCoverageArgs): BuildCoverageResult {
  const { mode, frames, plan, targetDurationSeconds } = args;
  const timestamps = frames.map((f) => f.timestampSeconds);
  const startSeconds = timestamps.length > 0 ? (timestamps[0] ?? 0) : 0;
  const endSeconds = timestamps.length > 0 ? (timestamps[timestamps.length - 1] ?? 0) : 0;

  const warnings: string[] = [];
  let complete = true;
  let acquisitionStatus: "success" | "partial" = "success";

  if (mode === "timestamp") {
    // 检测越界: 原始 input 超过 video 时长
    const outOfRange = (args.rawTimestamps ?? []).filter(
      (t) => t > targetDurationSeconds,
    );
    if (outOfRange.length > 0) {
      warnings.push(
        `${outOfRange.length} 个 timestamps 超过视频时长 ${targetDurationSeconds}s, 已被跳过: ${outOfRange.join(", ")}`,
      );
      complete = false;
      acquisitionStatus = "partial";
    }
  }

  if (mode === "interval") {
    if (plan.truncated) {
      complete = false;
      acquisitionStatus = "partial";
      warnings.push(
        `interval 计划抽 ${plan.plannedFrameCount} 帧, maxFrames=${plan.requestedFrameCount} 截断, 实际只覆盖前 ${Math.round(endSeconds)}s / ${targetDurationSeconds}s`,
      );
    } else if (frames.length < plan.plannedFrameCount) {
      // 没截断, 但实际抽到的 < 计划 (有 timestamp 失败, 或视频时长 < plan)
      complete = false;
      acquisitionStatus = "partial";
      warnings.push(
        `interval 计划 ${plan.plannedFrameCount} 帧, 实际抽到 ${frames.length} 帧`,
      );
    } else if (frames.length === plan.plannedFrameCount) {
      // 全部 plan 点都抽到, complete
      complete = true;
    }
  }

  if (mode === "scene") {
    // visualChanges truncated 时降为 partial.
    // 0 候选 = success (扫描完整), 不算 partial.
    // 0 candidate warning 用用户实际传入的 sceneThreshold, 不写死 0.4.
    const visualChangesCount = args.visualChanges?.length ?? 0;
    const thresholdStr = args.sceneThreshold !== undefined
      ? `通过阈值 ${args.sceneThreshold}`
      : "通过默认阈值";
    if (frames.length === 0 && visualChangesCount === 0) {
      warnings.push(
        `scene detection 没有找到任何${thresholdStr}的视觉变化点, 返回 0 帧 + 0 visualChanges (这是完整扫描结果, 不是采集失败)`,
      );
    } else if (frames.length === 0 && visualChangesCount > 0) {
      warnings.push(
        `scene detection 找到 ${visualChangesCount} 个候选, 但 extractScene 抽 0 张代表帧`,
      );
      acquisitionStatus = "partial";
    } else if (args.visualChangesTruncated) {
      // visualChanges 实际被 maxCandidates 截断, 显式降级.
      warnings.push(
        `scene detection 检测到 ${args.visualChangesTotal ?? "?"} 个视觉变化点, 超过 maxCandidates 内存保护被截断到 ${visualChangesCount} 个, editing_rhythm 分析可能不完整`,
      );
      acquisitionStatus = "partial";
    }
  }

  return {
    coverage: {
      startSeconds,
      endSeconds,
      targetDurationSeconds,
      frameCount: frames.length,
      plannedFrameCount: plan.plannedFrameCount,
      requestedFrameCount: plan.requestedFrameCount,
      extractedFrameCount: frames.length,
      truncated: plan.truncated,
      complete,
    },
    warnings,
    acquisitionStatus,
  };
}

interface FailOptions {
  videoUrl: string;
  requestedAt: string;
  reasonCode: string;
  message: string;
  retryable?: boolean;
  bvid?: string;
  cid?: string;
  videoKey?: string;
}

function fail(options: FailOptions): GetFramesOutput {
  const acqStatus: AcquisitionState = "failed";
  return GetFramesOutputSchema.parse({
    success: false,
    outcome: "failed",
    video: options.bvid
      ? { bvid: options.bvid, cid: options.cid }
      : undefined,
    reasonCode: options.reasonCode,
    message: options.message,
    acquisition: makeAcquisition({
      status: acqStatus,
      requestedAt: options.requestedAt,
      reasonCode: options.reasonCode,
      message: options.message,
      metadata: {
        retryable: options.retryable ?? false,
        bvid: options.bvid,
        cid: options.cid,
        videoKey: options.videoKey,
      },
    }),
    error: {
      code: options.reasonCode,
      message: options.message,
      retryable: options.retryable ?? false,
    },
    setupHint: options.reasonCode === FramesReasonCode.ffmpeg_unavailable
      ? makeSetupHint("media", "抽帧需要 ffmpeg，但当前环境不可用")
      : undefined,
  });
}

interface MakeAcquisitionOptions {
  status: "not_requested" | "success" | "partial" | "missing" | "failed";
  source?: string;
  requestedAt: string;
  message: string;
  reasonCode?: string;
  itemCount?: number;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

function makeAcquisition(options: MakeAcquisitionOptions): AcquisitionRecord {
  return AcquisitionRecordSchema.parse({
    dataKind: "frames",
    status: options.status,
    source: options.source ?? "bilibili_player_api",
    requestedAt: options.requestedAt,
    completedAt: new Date().toISOString(),
    reasonCode: options.reasonCode,
    message: options.message,
    itemCount: options.itemCount,
    warnings: options.warnings ?? [],
    metadata: options.metadata,
  });
}

/** 重新导出 BilibiliError, 方便上层 import. */
export { BilibiliError };
