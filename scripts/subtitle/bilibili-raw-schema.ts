import { z } from "zod";

/**
 * B站字幕接口原始字段 schema.
 *
 * 这里只描述 B站原始响应字段,任何业务字段(标准化语言/轨类型判断/URL 安全化)
 * 都在 subtitle/bilibili-adapter.ts 完成,不要在这里混入业务逻辑.
 */

/** 当前播放器二进制字幕接口中,单条字幕轨经解码后的最小字段集合. */
export const RawSubtitleTrackSchema = z.object({
  /** 字幕轨数字 ID;按字符串保存以避开 JavaScript 安全整数边界. */
  id: z.string().min(1),
  /** B站原始语言代码,例如 zh-CN、ai-zh. */
  lan: z.string().min(1),
  /** B站显示的完整语言名称. */
  lanDoc: z.string().optional(),
  /** B站显示的短语言名称. */
  lanDocBrief: z.string().optional(),
  /** 字幕正文原始地址;可能仍是播放器使用的加密地址. */
  subtitleUrl: z.string().optional(),
  /** 0 表示人工官方字幕,1 表示平台 AI 字幕. */
  type: z.number().int().optional(),
  /** 平台 AI 字幕状态;仅保留用于排查,不参与来源判断. */
  aiStatus: z.number().int().optional(),
  /** 0 表示 SRT/JSON 字幕,1 表示 ASS 字幕. */
  format: z.number().int().optional(),
}).passthrough();
export type RawSubtitleTrack = z.infer<typeof RawSubtitleTrackSchema>;

/** 当前播放器二进制字幕接口经解码后的最小结果. */
export const RawSubtitleViewSchema = z.object({
  /** 播放器当前语言偏好. */
  lan: z.string().optional(),
  /** 当前语言的显示名称. */
  lanDoc: z.string().optional(),
  /** 视频可用字幕轨. */
  subtitles: z.array(RawSubtitleTrackSchema),
});
export type RawSubtitleView = z.infer<typeof RawSubtitleViewSchema>;

/** 字幕正文容器;逐条内容单独校验,以便局部异常时保留可用片段. */
export const RawSubtitleBodySchema = z.object({
  /** B站字幕片段原始数组. */
  body: z.array(z.unknown()),
}).passthrough();
export type RawSubtitleBody = z.infer<typeof RawSubtitleBodySchema>;

/** 单条 B站字幕正文片段. */
export const RawSubtitleBodyItemSchema = z.object({
  /** 片段开始秒数. */
  from: z.number().nonnegative(),
  /** 片段结束秒数. */
  to: z.number().nonnegative(),
  /** 字幕原文. */
  content: z.string(),
}).passthrough().refine((item) => item.to >= item.from, {
  message: "字幕正文 to 必须大于等于 from",
});
export type RawSubtitleBodyItem = z.infer<typeof RawSubtitleBodyItemSchema>;
