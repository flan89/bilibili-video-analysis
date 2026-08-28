import { VideoRefSchema, type VideoRef } from "../models/video.js";
import { z } from "zod";
import { BilibiliClient, type BilibiliSubtitleClient } from "../bilibili/client.js";
import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import {
  discoverOfficialSubtitleTracks,
  fetchOfficialSubtitleBody,
  normalizeOfficialSubtitleBody,
  normalizeSubtitleLanguage,
  type SubtitleTrackCandidate,
} from "./bilibili-adapter.js";
import { AcquisitionRecordSchema, SetupHintSchema, type AcquisitionRecord } from "../models/acquisition.js";
import {
  TranscriptCleaningStatsSchema,
  TranscriptProcessingWarningSchema,
  TranscriptSchema,
  TranscriptSourceSchema,
} from "./model.js";
import {
  VideoMetadataSchema,
  VideoPageSchema,
  type VideoMetadata,
} from "../metadata/model.js";
import { cleanTranscript } from "./preprocessing.js";
import {
  runAsrTranscript,
  type RunAsrTranscriptResult,
} from "./asr/runner.js";
import { getBilibiliMetadata } from "../metadata/get.js";
import { makeSetupHint } from "../lib/setup-hint.js";

/** Tool 输入：只接受 Agent 自然拥有的视频标识和可选选择条件。 */
export const GetSubtitleInputSchema = z.object({
  /** B站视频 URL、BV号或 av号。 */
  video: z.string().min(1),
  /** 可选的底层分P cid；普通调用优先使用自然分P编号。 */
  cid: z.string().min(1).optional(),
  /** 用户自然指定的分P编号，从 1 开始；也可以由视频 URL 的 p 参数提供。 */
  page: z.number().int().positive().optional(),
  /** 可选目标语言；既支持标准化代码，也兼容 B站原始语言代码。 */
  language: z.string().min(1).optional(),
});
export type GetSubtitleInput = z.infer<typeof GetSubtitleInputSchema>;

/** 对 Agent 公开的字幕轨摘要，不包含临时正文 URL。 */
export const SubtitleTrackSummarySchema = z.object({
  /** 字幕轨 ID。 */
  id: z.string().min(1),
  /** 标准化语言代码。 */
  language: z.string().min(1),
  /** 平台显示的语言名称。 */
  languageLabel: z.string().optional(),
  /** 人工官方字幕或平台 AI 字幕。 */
  source: TranscriptSourceSchema.exclude(["asr"]),
  /** 当前轨道正文格式。 */
  format: z.enum(["srt", "ass"]),
  /** 当前是否有可请求的正文地址。 */
  accessible: z.boolean(),
});
export type SubtitleTrackSummary = z.infer<typeof SubtitleTrackSummarySchema>;

/** Tool 失败时返回的稳定错误结构。 */
export const SubtitleToolErrorSchema = z.object({
  /** 稳定程序错误码。 */
  code: z.string().min(1),
  /** 给用户和 Agent 阅读的错误说明。 */
  message: z.string().min(1),
  /** 是否建议原参数稍后重试。 */
  retryable: z.boolean(),
  /** 可选 HTTP 状态码。 */
  httpStatus: z.number().int().optional(),
  /** 可选 B站业务错误码。 */
  apiCode: z.number().int().optional(),
});
export type SubtitleToolError = z.infer<typeof SubtitleToolErrorSchema>;

/** 多P尚未选定时，供 Agent 展示和选择的最小分P信息。 */
export const SubtitlePageChoiceSchema = VideoPageSchema.pick({
  page: true,
  cid: true,
  title: true,
  durationSeconds: true,
});

/** 官方字幕和自动 ASR 均未取得正文时，给 Agent 的显式后续建议。 */
export const SubtitleFallbackSchema = z.object({
  /** 下一条可选策略：提取音频后进行自动语音识别。 */
  strategy: z.literal("audio_to_asr"),
  /** 为什么建议 Agent 考虑该策略。 */
  reason: z.string().min(1),
});

/** 字幕正文经过确定性清理后的可观察结果。 */
export const SubtitleProcessingSchema = z.object({
  /**
   * 当前处理方式:
   * - `deterministic_v1`: M1 官方字幕 + 确定性清理
   * - `asr_fallback`: M2 Level 3 ASR 转写 (无 deterministic 清洗)
   */
  method: z.enum(["deterministic_v1", "asr_fallback"]),
  /** 空白、排序和相邻完全重复字幕处理说明。 */
  warnings: z.array(TranscriptProcessingWarningSchema).default([]),
  /** 清理前后的数量变化 (ASR 时 input=output=segments.length, empty/duplicate=0). */
  stats: TranscriptCleaningStatsSchema,
});
export type SubtitleProcessing = z.infer<typeof SubtitleProcessingSchema>;

/** `bilibili.get_subtitle` 的无状态独立结果。 */
export const GetSubtitleOutputSchema = z.object({
  /** 是否已经得到可用 Transcript；partial 也属于可用。 */
  success: z.boolean(),
  /** 比 success 更细的结果分类。 */
  outcome: z.enum(["success", "missing", "selection_required", "failed"]),
  /** 能确定视频身份时返回；成功或 missing 时通常包含 cid。 */
  video: VideoRefSchema.optional(),
  /** 获取成功时直接返回给 Agent 的干净字幕。 */
  transcript: TranscriptSchema.optional(),
  /** 本次官方字幕采集记录。 */
  acquisition: AcquisitionRecordSchema,
  /** 已发现的轨道摘要，便于 Agent 处理语言选择。 */
  availableTracks: z.array(SubtitleTrackSummarySchema).default([]),
  /** 成功时返回确定性清理的统计与说明。 */
  processing: SubtitleProcessingSchema.optional(),
  /** 多P未选定时返回可选列表。 */
  pageChoices: z.array(SubtitlePageChoiceSchema).optional(),
  /** 无可用官方字幕时的后续建议。 */
  fallback: SubtitleFallbackSchema.optional(),
  /** 程序失败时的结构化错误。 */
  error: SubtitleToolErrorSchema.optional(),
  /**
   * 环境准备提示: 当 ASR 缺失 (e.g. venv 没创建 / Python 不可用) 时,
   * Tool 不会自己装, 而是返回 setupHint 让 Agent 调 setup 命令.
   * 跟 doc §十三 "Tool 永远不自动安装" 原则对齐.
   */
  setupHint: SetupHintSchema.optional(),
}).superRefine((output, context) => {
  if (output.success !== (output.outcome === "success")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["success"],
      message: "success 必须与 outcome=success 保持一致",
    });
  }
  if (output.success && (!output.video || !output.transcript || !output.processing)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transcript"],
      message: "字幕成功结果必须包含 video、transcript 和 processing",
    });
  }
  if (
    output.success
    && output.video
    && output.transcript
    && (!output.video.cid || output.video.cid !== output.transcript.cid)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["video", "cid"],
      message: "字幕成功结果的 video.cid 必须存在并与 transcript.cid 一致",
    });
  }
  if (output.outcome === "selection_required" && !output.pageChoices?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageChoices"],
      message: "多P待选择结果必须包含 pageChoices",
    });
  }
});
export type GetSubtitleOutput = z.infer<typeof GetSubtitleOutputSchema>;

/** 依赖注入用于离线单测，也允许调用方复用带 Cookie 的 Client。 */
export interface GetSubtitleDependencies {
  client?: BilibiliSubtitleClient;
  /** 可替换的 ASR 执行入口，便于只验证官方字幕链路的集成测试隔离本机环境。 */
  runAsr?: (input: { bvid: string; cid?: string }) => Promise<RunAsrTranscriptResult>;
}

function summarizeTrack(track: SubtitleTrackCandidate): SubtitleTrackSummary {
  return SubtitleTrackSummarySchema.parse({
    id: track.id,
    language: track.language,
    languageLabel: track.languageLabel,
    source: track.source,
    format: track.format,
    accessible: track.accessible,
  });
}

function makeAcquisition(options: {
  status: "not_requested" | "success" | "partial" | "missing" | "failed";
  requestedAt: string;
  source?: string;
  reasonCode?: string;
  message: string;
  itemCount?: number;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}): AcquisitionRecord {
  return AcquisitionRecordSchema.parse({
    dataKind: "transcript",
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

function selectCid(
  metadata: VideoMetadata,
  explicitCid?: string,
  requestedPage?: number,
):
  | { kind: "selected"; cid: string }
  | { kind: "selection_required" }
  | { kind: "failed"; error: BilibiliError } {
  const pages = metadata.pages;

  if (explicitCid) {
    const matchedPage = pages.find((page) => page.cid === explicitCid);
    if (!matchedPage) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_cid",
          message: `cid=${explicitCid} 不属于当前视频的分P列表`,
        }),
      };
    }
    if (requestedPage !== undefined && matchedPage.page !== requestedPage) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "conflicting_page_selection",
          message: `cid=${explicitCid} 对应第 ${matchedPage.page}P，与指定的第 ${requestedPage}P 不一致`,
        }),
      };
    }
    return { kind: "selected", cid: explicitCid };
  }

  if (requestedPage !== undefined) {
    const matchedPage = pages.find((page) => page.page === requestedPage);
    if (!matchedPage) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_page",
          message: `第 ${requestedPage}P 不属于当前视频，可选范围为 1-${pages.length}`,
        }),
      };
    }
    return { kind: "selected", cid: matchedPage.cid };
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
      message: "视频元信息没有可用于发现字幕的 cid",
    }),
  };
}

function trackMatchesLanguage(track: SubtitleTrackCandidate, language: string): boolean {
  const normalized = normalizeSubtitleLanguage(language).toLowerCase();
  const requested = language.toLowerCase();
  return track.languageAliases.includes(normalized)
    || track.languageAliases.includes(requested);
}

function selectTrack(
  tracks: SubtitleTrackCandidate[],
  requestedLanguage?: string,
  preferredLanguage?: string,
): SubtitleTrackCandidate | undefined {
  const supported = tracks.filter((track) => track.accessible && track.format === "srt");
  if (requestedLanguage) {
    return supported.find((track) => trackMatchesLanguage(track, requestedLanguage));
  }
  if (preferredLanguage) {
    const preferred = supported.find((track) => trackMatchesLanguage(track, preferredLanguage));
    if (preferred) return preferred;
  }
  return supported[0];
}

/**
 * 获取并清理官方字幕。
 *
 * Tool 自行解析视频和获取字幕接口需要的最小元信息；Agent 不需要先调用 Metadata
 * Tool 或传递共享对象。官方字幕缺失时会尝试 ASR；若环境不可用，则返回后续建议。
 */
export async function getBilibiliSubtitle(
  rawInput: GetSubtitleInput,
  dependencies: GetSubtitleDependencies = {},
): Promise<GetSubtitleOutput> {
  const input = GetSubtitleInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const runAsr = dependencies.runAsr ?? runAsrTranscript;
  const requestedAt = new Date().toISOString();
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    const normalized = toBilibiliError(error);
    const message = `解析字幕所需视频输入失败：${normalized.message}`;
    const acquisition = makeAcquisition({
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      reasonCode: normalized.code,
      message,
      metadata: {
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition,
      availableTracks: [],
      error: {
        code: normalized.code,
        message,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });
  }
  if (
    input.page !== undefined
    && resolvedInput.requestedPage !== undefined
    && input.page !== resolvedInput.requestedPage
  ) {
    const error = new BilibiliError({
      code: "conflicting_page_selection",
      message: `命令指定第 ${input.page}P，但视频 URL 指定第 ${resolvedInput.requestedPage}P`,
    });
    const acquisition = makeAcquisition({
      status: "failed",
      requestedAt,
      reasonCode: error.code,
      message: error.message,
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition,
      availableTracks: [],
      error: { code: error.code, message: error.message, retryable: false },
    });
  }
  const requestedPage = input.page ?? resolvedInput.requestedPage;
  const metadataResult = await getBilibiliMetadata(
    { video: resolvedInput.canonicalUrl, includeTags: false },
    { client },
  );

  if (!metadataResult.success || !metadataResult.metadata || !metadataResult.video) {
    const metadataError = metadataResult.error;
    const message = metadataError
      ? `获取字幕所需视频信息失败：${metadataError.message}`
      : "获取字幕所需视频信息失败";
    const acquisition = makeAcquisition({
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      reasonCode: metadataError?.code ?? "metadata_prerequisite_failed",
      message,
      metadata: {
        retryable: metadataError?.retryable ?? false,
        httpStatus: metadataError?.httpStatus,
        apiCode: metadataError?.apiCode,
      },
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition,
      availableTracks: [],
      error: {
        code: metadataError?.code ?? "metadata_prerequisite_failed",
        message,
        retryable: metadataError?.retryable ?? false,
        httpStatus: metadataError?.httpStatus,
        apiCode: metadataError?.apiCode,
      },
    });
  }

  const metadata = VideoMetadataSchema.parse(metadataResult.metadata);
  const baseVideo = VideoRefSchema.parse({ bvid: metadata.bvid });
  const cidResult = selectCid(metadata, input.cid, requestedPage);

  if (cidResult.kind === "selection_required") {
    const acquisition = makeAcquisition({
      status: "not_requested",
      requestedAt,
      reasonCode: "subtitle_cid_required",
      message: "多P视频尚未选择目标分P，未发起官方字幕请求",
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "selection_required",
      video: baseVideo,
      acquisition,
      availableTracks: [],
      pageChoices: metadata.pages,
    });
  }

  if (cidResult.kind === "failed") {
    const error = cidResult.error;
    const acquisition = makeAcquisition({
      status: "failed",
      requestedAt,
      reasonCode: error.code,
      message: error.message,
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "failed",
      video: baseVideo,
      acquisition,
      availableTracks: [],
      error: { code: error.code, message: error.message, retryable: error.retryable },
    });
  }

  const cid = cidResult.cid;
  const video = VideoRefSchema.parse({ bvid: metadata.bvid, cid });
  let availableTracks: SubtitleTrackSummary[] = [];

  try {
    const aid = metadata.aid;
    if (!aid) {
      throw new BilibiliError({
        code: "aid_unavailable",
        message: "视频元信息缺少字幕接口所需的 aid",
      });
    }

    // 开发期验证 Level 3 ASR 端到端的开关. 默认不启用.
    // 设置 `BILIBILI_SKILL_FORCE_ASR=1` 后跳过 Level 1 官方字幕, 直接调 ASR.
    // 不进 production input schema, 走 env var 是有意的:
    // 1) Skill API 保持干净, 不暴露"非自然"输入
    // 2) dev 验证用, 不希望 Agent / 用户在生产路径上误用
    // 3) 不影响 routing 决策 (D14 fallback 仍按 tracks.length === 0 触发)
    const forceAsr = process.env.BILIBILI_SKILL_FORCE_ASR === "1";
    if (forceAsr) {
      return await tryAsrFallback({
        bvid: metadata.bvid,
        cid,
        video,
        availableTracks: [],
        discoveryWarnings: ["level1_skipped_by_BILIBILI_SKILL_FORCE_ASR=1"],
        requestedAt,
        originalReasonCode: "no_official_subtitle",
        originalMessage: "BILIBILI_SKILL_FORCE_ASR=1 跳过 Level 1 官方字幕, 直接尝试 Level 3 ASR",
        runAsr,
      });
    }

    let subtitleAbsenceMessage = "字幕轨接口连续两次未观察到该分P的可用官方字幕";
    let discovery = await discoverOfficialSubtitleTracks(client, { aid, cid });
    if (discovery.tracks.length === 0) {
      // 真实测试确认匿名字幕轨接口会对确有字幕的视频偶发返回空轨。
      // Tool 在内部只做一次有限复核，避免把瞬时空响应误写成“视频没有字幕”，
      // 同时不把重试责任推给 Agent，防止连续重复请求。
      try {
        const rechecked = await discoverOfficialSubtitleTracks(client, { aid, cid });
        if (rechecked.tracks.length > 0) {
          discovery = {
            ...rechecked,
            warnings: [
              "字幕轨接口首次返回空结果，有限复核后恢复；本次字幕来源存在短暂波动",
              ...discovery.warnings,
              ...rechecked.warnings,
            ],
          };
        } else {
          discovery = {
            ...rechecked,
            warnings: [
              "字幕轨接口连续两次返回空结果；当前未观察到官方字幕，但匿名接口存在偶发空轨现象",
              ...discovery.warnings,
              ...rechecked.warnings,
            ],
          };
        }
      } catch (error) {
        // 首次请求已经形成可解释的空结果，补充复核失败不应把整项任务升级成失败；
        // 保留不确定性并继续走 ASR 降级，由 Agent 最终看到警告。
        const recheckError = toBilibiliError(error);
        subtitleAbsenceMessage = "字幕轨接口首次返回空结果，补充复核失败，当前无法确认该分P是否确实没有官方字幕";
        discovery = {
          ...discovery,
          warnings: [
            `字幕轨接口首次返回空结果，有限复核失败（${recheckError.code}）；当前无法确认官方字幕是否确实缺失`,
            ...discovery.warnings,
          ],
        };
      }
    }
    availableTracks = discovery.tracks.map(summarizeTrack);

    if (discovery.tracks.length === 0) {
      // D14 fallback: 官方字幕 missing 时尝试 Level 3 ASR.
      return await tryAsrFallback({
        bvid: metadata.bvid,
        cid,
        video,
        availableTracks,
        discoveryWarnings: discovery.warnings,
        requestedAt,
        originalReasonCode: "no_official_subtitle",
        originalMessage: subtitleAbsenceMessage,
        runAsr,
      });
    }

    const selectedTrack = selectTrack(
      discovery.tracks,
      input.language,
      discovery.preferredLanguage,
    );
    if (!selectedTrack) {
      const reasonCode = input.language
        ? "subtitle_language_not_found"
        : "subtitle_tracks_unavailable";
      const message = input.language
        ? `没有找到可下载的 ${input.language} 官方字幕`
        : "发现了字幕轨，但没有当前版本可下载和解析的正文";
      const acquisition = makeAcquisition({
        status: input.language ? "missing" : "failed",
        requestedAt,
        reasonCode,
        message,
        itemCount: 0,
        warnings: discovery.warnings,
        metadata: { cid, requestedLanguage: input.language },
      });
      const outcome = input.language ? "missing" : "failed";
      return GetSubtitleOutputSchema.parse({
        success: false,
        outcome,
        video,
        acquisition,
        availableTracks,
        fallback: input.language
          ? {
              strategy: "audio_to_asr",
              reason: "如目标语言文本是必需数据，可由 Agent 评估自动语音识别成本",
            }
          : undefined,
        error: outcome === "failed"
          ? { code: reasonCode, message, retryable: false }
          : undefined,
      });
    }

    const body = await fetchOfficialSubtitleBody(client, selectedTrack);
    const normalized = normalizeOfficialSubtitleBody(body, selectedTrack, cid);
    if (normalized.transcript.segments.length === 0) {
      const warnings = [...discovery.warnings, ...normalized.warnings];
      const acquisition = makeAcquisition({
        status: "missing",
        requestedAt,
        reasonCode: "empty_subtitle_body",
        message: "官方字幕轨存在，但正文没有字幕片段",
        itemCount: 0,
        warnings,
        metadata: { cid, subtitleTrackId: selectedTrack.id },
      });
      return GetSubtitleOutputSchema.parse({
        success: false,
        outcome: "missing",
        video,
        acquisition,
        availableTracks,
        fallback: {
          strategy: "audio_to_asr",
          reason: "官方字幕正文为空，如文本是必需数据，可由 Agent 决定是否改用自动语音识别",
        },
      });
    }

    const cleaned = cleanTranscript(normalized.transcript);
    const sourceWarnings = [...discovery.warnings, ...normalized.warnings];
    const acquisition = makeAcquisition({
      status: sourceWarnings.length > 0 ? "partial" : "success",
      requestedAt,
      message: sourceWarnings.length > 0
        ? "官方字幕获取成功，但来源存在被跳过或不可用的数据"
        : "官方字幕获取成功并已完成确定性清理",
      itemCount: cleaned.transcript.segments.length,
      warnings: sourceWarnings,
      metadata: {
        cid,
        requestedPage,
        subtitleTrackId: selectedTrack.id,
        language: cleaned.transcript.language,
        source: cleaned.transcript.source,
      },
    });

    return GetSubtitleOutputSchema.parse({
      success: true,
      outcome: "success",
      video,
      transcript: cleaned.transcript,
      processing: {
        method: "deterministic_v1",
        warnings: cleaned.warnings,
        stats: cleaned.stats,
      },
      acquisition,
      availableTracks,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    const acquisition = makeAcquisition({
      status: "failed",
      requestedAt,
      reasonCode: normalized.code,
      message: normalized.message,
      metadata: {
        cid,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
        retryable: normalized.retryable,
      },
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "failed",
      video,
      acquisition,
      availableTracks,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });
  }
}

/**
 * D14 fallback: Level 1 官方字幕缺失时, 尝试 Level 3 ASR 全链路.
 *
 * 行为:
 * - ASR 成功或部分成功 → 返回 outcome=success, transcript 来自 ASR (source="asr"),
 *   acquisition 保留 success / partial 状态及识别阶段的告警
 * - ASR 失败 → 返回原 missing 状态 + acquisition.warnings 追加 asr_unavailable
 *
 * 不向 Agent 隐藏 ASR 尝试: outcome=success 时 acquisition.source="funasr",
 * Agent 能从 result.acquisition 看出 transcript 不是官方字幕轨.
 */
async function tryAsrFallback(input: {
  bvid: string;
  cid: string;
  video: { bvid: string; cid?: string };
  availableTracks: ReturnType<typeof summarizeTrack>[];
  discoveryWarnings: string[];
  requestedAt: string;
  originalReasonCode: string;
  originalMessage: string;
  runAsr: (input: { bvid: string; cid?: string }) => Promise<RunAsrTranscriptResult>;
}): Promise<GetSubtitleOutput> {
  try {
    const asrResult = await input.runAsr({ bvid: input.bvid, cid: input.cid });
    if (
      asrResult.acquisition.status === "success" ||
      asrResult.acquisition.status === "partial"
    ) {
      // 部分成功通常只是少量过短语音片段被过滤，已有字幕仍然可以用于后续分析。
      const isPartial = asrResult.acquisition.status === "partial";
      const acquisition = makeAcquisition({
        status: asrResult.acquisition.status,
        source: "funasr",
        requestedAt: input.requestedAt,
        message: isPartial
          ? "Level 1 官方字幕缺失, 通过 Level 3 ASR fallback 获得部分 Transcript"
          : "Level 1 官方字幕缺失, 通过 Level 3 ASR fallback 获得 Transcript",
        itemCount: asrResult.transcript.segments.length,
        warnings: [...input.discoveryWarnings, ...asrResult.acquisition.warnings],
        metadata: {
          cid: input.cid,
          fallbackFrom: input.originalReasonCode,
          asrProvider: asrResult.acquisition.source,
          asrSource: asrResult.transcript.source,
        },
      });
      return GetSubtitleOutputSchema.parse({
        success: true,
        outcome: "success",
        video: input.video,
        transcript: asrResult.transcript,
        processing: {
          method: "asr_fallback",
          warnings: [],
          stats: {
            inputSegmentCount: asrResult.transcript.segments.length,
            outputSegmentCount: asrResult.transcript.segments.length,
            emptySegmentCount: 0,
            duplicateSegmentCount: 0,
          },
        },
        acquisition,
        availableTracks: input.availableTracks,
      });
    }
    // ASR 失败: 保留原 missing, 但加 warning
    const acquisition = makeAcquisition({
      status: "missing",
      source: "bilibili_player_api",
      requestedAt: input.requestedAt,
      reasonCode: input.originalReasonCode,
      message: input.originalMessage,
      itemCount: 0,
      warnings: [
        ...input.discoveryWarnings,
        `asr_unavailable: ${asrResult.acquisition.reasonCode ?? "unknown"} - ${asrResult.acquisition.message ?? ""}`,
      ],
      metadata: {
        cid: input.cid,
        asrAttempted: true,
        asrReasonCode: asrResult.acquisition.reasonCode,
      },
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "missing",
      video: input.video,
      acquisition,
      availableTracks: input.availableTracks,
      fallback: {
        strategy: "audio_to_asr",
        reason: "Level 1 官方字幕缺失, Level 3 ASR 也未能生成可用 Transcript",
      },
      // 跟 doc §十三: Tool 永远不自己装, 给 Agent setupHint 调 setup 命令
      setupHint: ["asr_python_not_found", "asr_runtime_unavailable"].includes(
        asrResult.acquisition.reasonCode ?? "",
      )
        ? makeSetupHint("asr", "本地 ASR 隔离环境或固定版本模型尚未准备完成")
        : undefined,
    });
  } catch (error) {
    // ASR runner 本身抛错 (编程错误, 不是业务错误)
    const acquisition = makeAcquisition({
      status: "missing",
      source: "bilibili_player_api",
      requestedAt: input.requestedAt,
      reasonCode: input.originalReasonCode,
      message: input.originalMessage,
      itemCount: 0,
      warnings: [
        ...input.discoveryWarnings,
        `asr_runner_exception: ${(error as Error).message}`,
      ],
      metadata: { cid: input.cid, asrAttempted: true, asrError: true },
    });
    return GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "missing",
      video: input.video,
      acquisition,
      availableTracks: input.availableTracks,
      fallback: {
        strategy: "audio_to_asr",
        reason: "Level 1 官方字幕缺失, ASR 包装器异常",
      },
    });
  }
}
