/**
 * scripts/visual/model.ts: 视觉拆解数据模型.
 *
 * 复用 scripts/models/frame.ts 的 FrameSchema (含 uri / reason /
 * perceptualHash). 本文件只定义:
 *   - Coverage: 帧覆盖范围
 *   - FrameSet: 一次抽帧的完整结果
 *   - GetFramesOutput: getBilibiliFrames Tool 入口输出
 *   - ReasonCode 枚举: 失败结构化错误码
 *
 * 平台边界: B 站原始字段不直接进业务层. 视觉证据本身不涉及 B 站
 * 字段, 但 ffmpeg 失败信息 (exit code / stderr) 锁在本层.
 */
import { z } from "zod";

import { AcquisitionRecordSchema, SetupHintSchema } from "../models/index.js";
import { FrameSchema } from "../models/frame.js";
import { ExtraMetadataSchema, MediaTimeSecondsSchema } from "../models/common.js";

/**
 * 抽帧模式。
 *
 * 注意: B 站 ffmpeg scene score 不能准确知道导演意义上的镜头, 这里
 * 用 "scene" 作为命名, 暗示这是 "visual change candidate" 而非
 * 严格的 "shot / cut".
 */
export const FrameExtractionModeSchema = z.enum([
  "timestamp", // 精确时间点
  "interval", // 固定时间间隔采样
  "scene", // 视觉变化候选 (scene-change score)
]);
export type FrameExtractionMode = z.infer<typeof FrameExtractionModeSchema>;

/**
 * 帧覆盖范围.
 *
 * `FrameSet.complete` 的关键含义：
 *   `complete` = "请求的视觉采样计划是否完整执行"
 *   **不是** "这些图片完整代表整个视频所有视觉信息"
 *
 * Agent 必须理解这个区别, 降低结论强度.
 *
 * Coverage 字段扩展:
 *   - plannedFrameCount: 计划帧数 (interval 模式按完整 plan 算, scene 模式按 cap 算)
 *   - requestedFrameCount: 实际请求帧数 (plannedFrameCount 与 maxFrames 取小)
 *   - extractedFrameCount: 真实抽到帧数
 *   - truncated: 计划 > maxFrames 时被截断
 *
 * Coverage 字段扩展:
 *   - mediaDurationShortageRatio: downloaded media 实际时长 / expectedDurationSeconds
 *     DASH 拼装不全时 < 1.0, 让 Agent 一眼看出"视觉证据只覆盖前 X%"
 *   - expectedDurationSeconds: metadata page 的标准时长, reference target
 */
export const CoverageSchema = z.object({
  /** 帧覆盖起点 (秒). */
  startSeconds: MediaTimeSecondsSchema,
  /** 帧覆盖终点 (秒). */
  endSeconds: MediaTimeSecondsSchema,
  /** 目标视频总时长 (秒). */
  targetDurationSeconds: MediaTimeSecondsSchema,
  /** 帧数 (实际抽到的, = frames.length). */
  frameCount: z.number().int().nonnegative(),
  /** 计划帧数 (interval/scene 才有, timestamp 没计划概念). */
  plannedFrameCount: z.number().int().nonnegative().optional(),
  /** 请求帧数 (= min(planned, maxFrames)). */
  requestedFrameCount: z.number().int().nonnegative().optional(),
  /** 实际抽到帧数. 通常 = frameCount, 但当某些帧失败时可能更少. */
  extractedFrameCount: z.number().int().nonnegative().optional(),
  /** 是否被 maxFrames 截断. */
  truncated: z.boolean().optional(),
  /** 请求的采样计划是否完整执行. */
  complete: z.boolean(),
  /** downloaded media 实际时长 / expectedDurationSeconds.
   * DASH 拼装不全时 < 1.0, Agent 一眼看出"视觉证据只覆盖前 X%". */
  mediaDurationShortageRatio: z.number().positive().optional(),
  /** metadata 报告的目标 page 时长, reference target. */
  expectedDurationSeconds: MediaTimeSecondsSchema.optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

/** 视觉变化候选 (scene mode 才有).
 *
 * 删 score 字段, 避免假证据.
 * 字段语义: "这个时间点的画面变化强度通过了 threshold"
 * 不要再加 score 数值, 用户会过度解读成 "0.57 比 0.43 更重要".
 */
export const VisualChangeSchema = z.object({
  /** 视频内时间点 (秒). */
  timestampSeconds: MediaTimeSecondsSchema,
});
export type VisualChange = z.infer<typeof VisualChangeSchema>;

/**
 * 一次 getBilibiliFrames 调用的完整结果.
 *
 * 复用 FrameSchema (scripts/models/frame.ts), 不重定义 VisualFrame.
 *
 * 加 visualChanges 字段, scene mode 返回完整 timeline
 *   (不限 maxFrames, 让 Agent 自己用 timeline 算 editing_rhythm).
 *
 * scene-detector 改为真实返回全量 visualChanges
 *   (之前 200/400 cap 静默截断, 文档承诺跟代码不一致),
 *   加 visualChangesTotal / visualChangesTruncated 字段让 Agent
 *   判断 timeline 完整性.
 */
export const FrameSetSchema = z.object({
  /** 视频标识. */
  video: z.object({
    bvid: z.string().min(1),
    cid: z.string().min(1),
  }),
  /** 抽帧模式. */
  mode: FrameExtractionModeSchema,
  /** 帧列表 (按 timestampSeconds 升序). */
  frames: z.array(FrameSchema),
  /** 帧覆盖范围. */
  coverage: CoverageSchema,
  /** 完整视觉变化时间轴 (scene mode 才有). */
  visualChanges: z.array(VisualChangeSchema).optional(),
  /** 视觉变化时间轴总候选数 (scene-detector 真实检测到, 加).
   * 跟 visualChanges.length 配合: 相等 = 未截断, 不等 = 截断到 memoryCap. */
  visualChangesTotal: z.number().int().nonnegative().optional(),
  /** 视觉变化时间轴是否被 maxCandidates 内存保护截断 (加). */
  visualChangesTruncated: z.boolean().optional(),
  /** 单类数据采集状态 (复用 models/acquisition). */
  acquisition: AcquisitionRecordSchema,
  /** 警告信息 (例如 scene mode 但 ffmpeg 不可用, mode=timestamp 但指定时间点超过视频时长). */
  warnings: z.array(z.string()).default([]),
  /** 补充信息. */
  metadata: ExtraMetadataSchema.optional(),
});
export type FrameSet = z.infer<typeof FrameSetSchema>;

/**
 * getBilibiliFrames Tool 输入.
 *
 * 复用 VideoRef 模式: video 接受 URL / BV / av;
 * 可选 cid 或 page（自然分P编号，与其它视频 Tool 一致）。
 *
 * 抽帧相关参数按 mode 二选一 (用 z.discriminatedUnion 强制):
 *   - timestamp: 精确时间点列表
 *   - interval: 固定时间间隔 + maxFrames
 *   - scene: ffmpeg scene-change score 阈值 + maxFrames
 */
const MAX_INPUT_FRAMES = 100;
const DEFAULT_SCENE_THRESHOLD = 0.4;
const DEFAULT_MAX_FRAMES = 50;

export const GetFramesInputSchema = z
  .object({
    /** 视频 URL / BV号 / av号. */
    video: z.string().min(1),
    /** 可选分P cid. */
    cid: z.string().min(1).optional(),
    /** 可选分P 编号 (1 开始). */
    page: z.number().int().positive().optional(),

    /** 抽帧模式. */
    mode: FrameExtractionModeSchema,

    /** mode=timestamp: 精确时间点列表 (秒). 上限 100, Agent 错误大数会被截断. */
    timestamps: z.array(z.number().nonnegative()).max(MAX_INPUT_FRAMES).optional(),

    /** mode=interval: 采样间隔 (秒). */
    intervalSeconds: z.number().positive().optional(),
    /** mode=interval / scene: 最大帧数. 默认 50, 上限 100. */
    maxFrames: z.number().int().positive().max(MAX_INPUT_FRAMES).default(DEFAULT_MAX_FRAMES),

    /** mode=scene: ffmpeg scene-change score 阈值 (0-1, 默认 0.4). */
    sceneThreshold: z.number().min(0).max(1).default(DEFAULT_SCENE_THRESHOLD),

    /** 分辨率. 默认 720p (qn=64, 匿名稳定). typography/UI/PPT 小字用 1080p (qn=80, 需登录). */
    resolution: z.enum(["720p", "1080p"]).default("720p"),

    /** 下载视频源超时 (毫秒). 默认 120000 (2 分钟). */
    downloadTimeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .refine(
    (v) => {
      if (v.mode === "timestamp") {
        return v.timestamps !== undefined && v.timestamps.length > 0;
      }
      if (v.mode === "interval") {
        return v.intervalSeconds !== undefined;
      }
      // scene: schema 已用 .default() 补默认, refine 永远通过
      return true;
    },
    {
      message:
        "mode=timestamp 需要 timestamps (非空数组), mode=interval 需要 intervalSeconds",
    },
  );
export type GetFramesInput = z.input<typeof GetFramesInputSchema>;


/**
 * getBilibiliFrames Tool 输出.
 */
export const GetFramesOutputSchema = z.object({
  success: z.boolean(),
  outcome: z.enum(["success", "selection_required", "failed"]),
  video: z
    .object({
      bvid: z.string().min(1),
      cid: z.string().optional(),
    })
    .optional(),
  frameset: FrameSetSchema.optional(),
  pageChoices: z
    .array(
      z.object({
        page: z.number().int().positive(),
        cid: z.string().min(1),
        title: z.string().optional(),
        durationSeconds: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
  acquisition: AcquisitionRecordSchema.optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean().default(false),
    })
    .optional(),
  /** 失败原因码 (顶层 alias, 兼容老 fixture + visual-decode 协议). */
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  /** 缺少 ffmpeg 时返回；Tool 本身不会安装。 */
  setupHint: SetupHintSchema.optional(),
});
export type GetFramesOutput = z.infer<typeof GetFramesOutputSchema>;

/**
 * getBilibiliFrames 失败 reasonCode 枚举.
 *
 * reasonCode 与弹幕、评论、字幕 Tool 采用相同的结构化失败风格：
 *   - 4 个 Tool 失败 (跟 subtitle / danmaku / comments 风格)
 *   - 4 个 ffmpeg 平台细节 (本地进程失败, 不外泄到 Tool 输出)
 */
export const FramesReasonCode = {
  metadata_prerequisite_failed: "metadata_prerequisite_failed", // metadata Tool 失败
  conflicting_page_selection: "conflicting_page_selection", // cid / page / URL p 互冲
  unknown_page: "unknown_page", // 指定 page 越界
  unknown_cid: "unknown_cid", // 指定 cid 不在分P 列表
  cid_unavailable: "cid_unavailable", // 视频无 cid
  aid_unavailable: "aid_unavailable", // 视频无 aid
  playurl_prerequisite_failed: "playurl_prerequisite_failed", // playurl 失败
  ffmpeg_unavailable: "ffmpeg_unavailable", // ffmpeg 不在 PATH
  scene_detection_failed: "scene_detection_failed", // ffmpeg scene 检测失败
  frame_extraction_failed: "frame_extraction_failed", // ffmpeg 提帧失败
  unexpected_error: "unexpected_error", // 未捕获
} as const;
export type FramesReasonCodeValue =
  (typeof FramesReasonCode)[keyof typeof FramesReasonCode];
