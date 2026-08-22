/**
 * scripts/bilibili/playurl.ts: B 站 playurl 接口 (M2 ASR / M5 视觉共享).
 *
 * 用途: 拿视频/音频 m4s 流 URL.
 *   M2 用 audio stream (ASR pipeline 需要)
 *   M5 用 video stream (视觉拆解 ffmpeg 提帧)
 *
 * 接口: GET /x/player/wbi/playurl (主推, 跟 yt-dlp / bilibili-api-collect 一致)
 *        旧 /x/player/playurl 仍兼容, 但已 legacy.
 *   query: avid / cid / qn / fnval=16 (DASH) / fnver / fourk / platform / high_quality
 *   走 WBI 签名 (M3 实现的 scripts/bilibili/wbi.ts)
 *
 * DASH m4s 协议: 返回 baseUrl + segment_base (Initialization, 视频头段) +
 * 后续分片 URL 模板. M5 ffmpeg 提帧时只需要 initialization 段就能解码视频头.
 *
 * D12 边界: 本文件只处理 B 站 playurl 机制, 不混入业务逻辑.
 *   - audio 解析: 留给 M2 (asr/pipeline.py 拼 audio URL)
 *   - video 解析 + ffmpeg 提帧: 留给 M5 (scripts/visual/frame-extractor.ts)
 *   - 业务层只调 resolvePlayUrl, 拿 VideoStreamInfo
 *
 * 已知限制:
 *   - datacenter IP 限速 (具体阈值因项目而异, 不写死)
 *   - 高画质 (qn>=80) 必须 WBI 签名 + 登录态
 *   - 匿名访问通常稳定 qn=64 (720P), qn=80 (1080P) 经常被强制降到 64
 *   - 4K 经常需要登录态
 */
import { z } from "zod";

import { BilibiliError } from "./errors.js";
import type { BilibiliApiClient } from "./client.js";
import { WbiSigner } from "./wbi.js";

/**
 * playurl 接口响应 schema (DASH 模式, fnval=16).
 *
 * 关键字段:
 *   - data.quality: 当前返回的质量码
 *   - data.accept_quality: 该视频可用质量码列表
 *   - data.dash.duration: 视频总时长 (秒)
 *   - data.dash.video[]: 视频流 (可能有多个清晰度)
 *   - data.dash.audio[]: 音频流
 *   - data.dash.video[i].baseUrl / base_url: 完整 m4s 媒体地址
 *   - data.dash.video[i].SegmentBase: byte ranges such as 0-1021, not Base64 content
 *
 * B 站历史包袱: baseUrl 字段有时是 baseUrl, 有时是 base_url (老接口),
 * 两个都接受 (z.union / 可选).
 */
const SegmentBaseSchema = z.object({
  Initialization: z.string().optional(),
  initialization: z.string().optional(),
  indexRange: z.string().optional(),
  index_range: z.string().optional(),
});

export const PlayUrlDashSchema = z.object({
  code: z.number(),
  message: z.string().default(""),
  ttl: z.number().optional(),
  data: z.object({
    from: z.string().optional(),
    result: z.string().optional(),
    message: z.string().optional(),
    quality: z.number(),
    format: z.string().optional(),
    timelength: z.number().optional(),
    accept_format: z.string().optional(),
    accept_description: z.array(z.string()).optional(),
    accept_quality: z.array(z.number()).optional(),
    video_codecid: z.number().optional(),
    seek_param: z.string().optional(),
    seek_type: z.string().optional(),
    dash: z
      .object({
        duration: z.number(),
        minBufferTime: z.number().optional(),
        min_period: z.number().optional(),
        video: z.array(
          z
            .object({
              id: z.number(),
              baseUrl: z.string().optional(),
              base_url: z.string().optional(),
              mimeType: z.string().optional(),
              codecs: z.string().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              frameRate: z.string().optional(),
              sar: z.string().optional(),
              startWithSap: z.number().optional(),
              segment_base: SegmentBaseSchema.optional(),
              SegmentBase: SegmentBaseSchema.optional(),
              codecid: z.number().optional(),
              bandwidth: z.number().optional(),
            })
            .refine(
              (v) => v.baseUrl !== undefined || v.base_url !== undefined,
              { message: "video 流必须有 baseUrl 或 base_url" },
            ),
        ),
        audio: z
          .array(
            z
              .object({
                id: z.number(),
                baseUrl: z.string().optional(),
                base_url: z.string().optional(),
                mimeType: z.string().optional(),
                codecs: z.string().optional(),
                segment_base: SegmentBaseSchema.optional(),
                SegmentBase: SegmentBaseSchema.optional(),
                bandwidth: z.number().optional(),
              })
              .refine(
                (v) => v.baseUrl !== undefined || v.base_url !== undefined,
                { message: "audio 流必须有 baseUrl 或 base_url" },
              ),
          )
          .default([]),
        dolby: z.unknown().optional(),
        flac: z.unknown().optional(),
      })
      .optional(),
    durl: z
      .array(
        z.object({
          order: z.number().optional(),
          length: z.number().optional(),
          size: z.number().optional(),
          url: z.string(),
          backup_url: z.union([z.string(), z.array(z.string())]).nullable().optional(),
          ahead: z.string().optional(),
          vhead: z.string().optional(),
        }),
      )
      .optional(),
    play_view_business_info: z.unknown().optional(),
  }),
});

export type PlayUrlDash = z.infer<typeof PlayUrlDashSchema>;

/**
 * B 站画质代码 (qn) 标准映射.
 * 真实值参考 https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/video/videostream_url.md
 *
 * 重要:
 *   - 64 = 720P (WEB 默认, 匿名稳定)
 *   - 80 = 1080P (TV/APP 默认, 通常需登录态, 匿名常被强制降到 64)
 *   - 112 = 1080P+ 高码率 (大会员)
 *   - 116 = 1080P60 (大会员)
 *   - 120 = 4K (大会员)
 *
 * M5 默认匿名访问, 稳定画质是 720P (qn=64).
 * typography/UI/PPT 小字需要 1080P 时用 full_hd=80, 但要求环境提供 SESSDATA.
 */
export const QualityCode = {
  ultra_fast: 6, // 240P 极速 (仅 mp4)
  fluent: 16, // 360P 流畅
  standard: 32, // 480P 清晰 (匿名 fallback)
  hd: 64, // 720P 高清 (WEB 默认, 匿名稳定, M5 默认)
  hd_60: 74, // 720P60 高帧率 (登录)
  full_hd: 80, // 1080P 高清 (登录, typography/UI 推荐)
  full_hd_high: 112, // 1080P+ 高码率 (大会员)
  full_hd_60: 116, // 1080P60 高帧率 (大会员)
  four_k: 120, // 4K 超高清 (大会员, fourk=1)
  eight_k: 127, // 8K 极清 (极少视频)
} as const;
export type QualityCodeValue = (typeof QualityCode)[keyof typeof QualityCode];

/** 视频流信息. M5 ffmpeg 提帧用 videoBaseUrl + videoInit. M2 ASR 用 audioBaseUrl + audioInit. */
export interface VideoStreamInfo {
  /** 当前返回的质量码. */
  quality: number;
  /** 视频总时长 (秒). */
  durationSeconds: number;
  /** 视频流 baseUrl（完整 m4s 媒体地址）. */
  videoBaseUrl: string;
  /** DASH initialization byte range, for example 0-1021. */
  videoInit: string;
  /** 视频 MIME type (例: video/mp4). */
  videoMimeType: string;
  /** 视频编解码 (例: avc1.64001F). */
  videoCodecs: string;
  /** 视频宽度 (像素). */
  videoWidth?: number;
  /** 视频高度 (像素). */
  videoHeight?: number;
  /** 视频比特率 (bps). */
  videoBandwidth?: number;
  /** 视频段索引范围 (例: "0-100"). ffmpeg seek 用. */
  videoSegmentIndexRange?: string;
  /** 音频流 baseUrl. M2 ASR 用. */
  audioBaseUrl?: string;
  /** DASH audio initialization byte range, not Base64 content. */
  audioInit?: string;
  /** 音频 MIME type. */
  audioMimeType?: string;
  /** 音频编解码. */
  audioCodecs?: string;
  /** 音频比特率. */
  audioBandwidth?: number;
  /** 视频可用质量码列表. */
  acceptQuality: number[];

  /**
   * 备选: durl 单文件 URL 列表 (老视频用).
   * B 站对一些老视频不返 DASH 分片, 只返单个 mp4 URL.
   * M5 ffmpeg 提帧优先用 videoBaseUrl (DASH), fallback 到 durlUrls[0] (单文件).
   */
  durlUrls?: string[];
}

export interface ResolvePlayUrlOptions {
  /** 视频 avid. */
  aid: string | number;
  /** 分P cid. */
  cid: string | number;
  /** 目标质量码 (默认 80 = 720p). */
  quality?: number;
  /** DASH 协议 (默认 true, fnval=16). */
  dash?: boolean;
  /** 优先 4K (默认 false, fourk=1). */
  fourk?: boolean;
  /** 强制最新 (默认 true, fnver=0). */
  fnver?: number;
  /** 自定义 fetch (测试用). */
  fetchImpl?: typeof fetch;
  /** 自定义 User-Agent. */
  userAgent?: string;
  /** 可选 Cookie (高画质 / 登录态需求时). */
  cookie?: string;
}

/**
 * 调 /x/player/wbi/playurl 拿 DASH/durl 视频/音频流 URL.
 * 走 WBI 签名, 失败结构化错误.
 *
 * 注意: 不用 client.getApiData, 因为 WBI 签名后的 query 已经包含完整 URL 参数,
 * getApiData 会重复加 searchParams 冲突.
 */
export async function resolvePlayUrl(
  client: BilibiliApiClient,
  options: ResolvePlayUrlOptions,
  wbiSigner: WbiSigner = new WbiSigner(),
): Promise<VideoStreamInfo> {
  const quality = options.quality ?? QualityCode.hd;
  const dash = options.dash ?? true;
  const fourk = options.fourk ?? false;
  const fnver = options.fnver ?? 0;

  const params: Record<string, string | number | boolean | undefined> = {
    avid: options.aid,
    cid: options.cid,
    qn: quality,
    fnval: dash ? 16 : 1,
    fnver,
    fourk: fourk ? 1 : 0,
    platform: "html5",
    high_quality: 1,
  };

  // 拿 WBI 签名 (走 wbiSigner 内部 nav 接口缓存)
  const signedQuery = await wbiSigner.signRequest(client, params);

  // 拼完整 URL. baseUrl 来自 client (默认 https://api.bilibili.com/).
  // 用 wbi/playurl 端点 (跟 yt-dlp / bilibili-api-collect 一致), 旧 /x/player/playurl 兼容但 legacy.
  const baseUrl =
    (client as { baseUrl?: string }).baseUrl ?? "https://api.bilibili.com/";
  const url = new URL(`/x/player/wbi/playurl?${signedQuery}`, baseUrl);

  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent =
    options.userAgent ??
    (client as { userAgent?: string }).userAgent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": userAgent,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
  } catch (e) {
    throw new BilibiliError({
      code: "playurl_http_error",
      message: `playurl 请求网络错误: ${(e as Error).message}`,
      retryable: true,
      cause: e,
    });
  }

  if (!response.ok) {
    throw new BilibiliError({
      code: "playurl_http_error",
      message: `playurl HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e) {
    throw new BilibiliError({
      code: "playurl_parse_error",
      message: `playurl 返 JSON 解析失败: ${(e as Error).message}`,
      cause: e,
    });
  }

  const parsed = PlayUrlDashSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BilibiliError({
      code: "playurl_invalid_data",
      message: "playurl 返 JSON 跟 schema 不匹配",
      cause: parsed.error,
    });
  }

  const env = parsed.data;
  if (env.code !== 0) {
    throw new BilibiliError({
      code: "playurl_api_error",
      message: env.message || `playurl 返 code=${env.code}`,
      apiCode: env.code,
      retryable: env.code === -412 || env.code === -509,
    });
  }

  // 选 video 流: 优先 DASH, fallback durl (老视频)
  const dashData = env.data.dash;
  const durlData = env.data.durl;

  if (!dashData && (!durlData || durlData.length === 0)) {
    throw new BilibiliError({
      code: "playurl_no_video_stream",
      message: "playurl 既没有 DASH 也没有 durl 流",
    });
  }

  let videoBaseUrl: string;
  let videoInit: string;
  let videoMimeType: string;
  let videoCodecs: string;
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let videoBandwidth: number | undefined;
  let videoSegmentIndexRange: string | undefined;
  let durlUrls: string[] | undefined;

  if (dashData && dashData.video.length > 0) {
    // DASH 模式 (新视频)
    const video =
      dashData.video.find((v) => v.id === env.data.quality) ?? dashData.video[0];
    if (!video) {
      throw new BilibiliError({
        code: "playurl_no_video_stream",
        message: "playurl DASH video 列表为空",
      });
    }
    videoBaseUrl = video.baseUrl ?? video.base_url ?? "";
    const videoSegmentBase = video.SegmentBase ?? video.segment_base;
    videoInit = videoSegmentBase?.Initialization ?? videoSegmentBase?.initialization ?? "";
    videoMimeType = video.mimeType ?? "video/mp4";
    videoCodecs = video.codecs ?? "avc1.64001F";
    videoWidth = video.width;
    videoHeight = video.height;
    videoBandwidth = video.bandwidth;
    videoSegmentIndexRange = videoSegmentBase?.indexRange ?? videoSegmentBase?.index_range;
  } else {
    // durl 模式 (老视频, 单文件 mp4)
    if (!durlData || durlData.length === 0 || !durlData[0]) {
      throw new BilibiliError({
        code: "playurl_no_video_stream",
        message: "playurl durl 也空",
      });
    }
    const firstDurl = durlData[0];
    videoBaseUrl = firstDurl.url;
    videoInit = ""; // durl 是完整 mp4, 不需要 init 段
    videoMimeType = "video/mp4";
    videoCodecs = "avc1.64001F";
    durlUrls = durlData.map((d) => d.url);
  }

  if (!videoBaseUrl) {
    throw new BilibiliError({
      code: "playurl_no_video_stream",
      message: "playurl 视频流缺 baseUrl",
    });
  }

  // audio 流 (M2 ASR 用, M5 不用但仍返回)
  // DASH 模式才有 audio; durl 老视频没有 DASH audio
  const audio = dashData?.audio[0];
  const audioBaseUrl = audio?.baseUrl ?? audio?.base_url;
  const audioSegmentBase = audio?.SegmentBase ?? audio?.segment_base;
  const audioInit = audioSegmentBase?.Initialization ?? audioSegmentBase?.initialization;

  return {
    quality: env.data.quality,
    durationSeconds: dashData?.duration ?? 0,
    videoBaseUrl,
    videoInit,
    videoMimeType,
    videoCodecs,
    videoWidth,
    videoHeight,
    videoBandwidth,
    videoSegmentIndexRange,
    audioBaseUrl,
    audioInit,
    audioMimeType: audio?.mimeType,
    audioCodecs: audio?.codecs,
    audioBandwidth: audio?.bandwidth,
    acceptQuality: env.data.accept_quality ?? [env.data.quality],
    durlUrls,
  };
}
