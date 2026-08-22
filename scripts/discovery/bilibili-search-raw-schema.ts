/**
 * scripts/discovery/bilibili-search-raw-schema.ts: B 站视频搜索接口原始字段 schema.
 *
 * 协议: x/web-interface/wbi/search/type (search_type=video, 需要 WBI 签名).
 *
 * 平台特性 (与评论/元数据接口不同的地方):
 * - 标题和简介带高亮标记 <em class="keyword">...</em>;
 * - arcurl 常见形态是 "http://www.bilibili.com/video/av<aid>" (av 号地址,
 *   不是协议相对地址, 也不含 BV 号), 视频身份优先取 bvid 字段;
 * - 播放/弹幕/收藏等统计经常是字符串, 缺失时用 "--" 占位;
 * - typeid / pubdate 等数值字段在真实响应中可能是字符串 (2026-08 真实响应取证),
 *   因此数值字段一律接受 number | string, 由适配层转换;
 * - result 里可能混入非视频条目 (特殊卡片等), 因此 data 级 schema 对
 *   result 只做"数组"约束, 单条结构由适配层逐条校验;
 * - 空结果时 result 可能是 [] 也可能是 null.
 *
 * D12 边界: 本文件只描述 B 站原始响应结构, 业务标准化 (去高亮 / URL
 * 规范化 / 时长解析 / 统计转换) 在 bilibili-search-adapter.ts 完成.
 */
import { z } from "zod";

/**
 * 单条搜索结果原始条目.
 * 字段大量可选: 平台可能缺失或用 "--" 占位, 适配层负责保守处理.
 */
export const RawSearchVideoItemSchema = z.object({
  /** 结果类型; 视频搜索通常为 "video", 其它类型条目由适配层过滤. */
  type: z.string().optional(),
  /** 稿件 aid; 真实响应可能是字符串形式的数字. */
  id: z.union([z.number(), z.string()]).optional(),
  /** BV 号; 部分响应缺失, 需要从 arcurl 兜底提取. */
  bvid: z.string().optional(),
  /** 视频地址; 常见 "http://www.bilibili.com/video/av<aid>", 也可能是协议相对 BV 地址. */
  arcurl: z.string().optional(),
  /** UP 主昵称. */
  author: z.string().optional(),
  /** UP 主 mid. */
  mid: z.union([z.number(), z.string()]).optional(),
  /** UP 主头像地址 (部分响应缺失). */
  upic: z.string().optional(),
  /** 标题; 含平台高亮标记. */
  title: z.string(),
  /** 简介摘要; 含平台高亮标记. */
  description: z.string().optional(),
  /** 封面地址；当前真实搜索响应使用该字段。 */
  pic: z.string().optional(),
  /** 历史或部分响应中的封面字段，适配层作为兼容兜底读取。 */
  picture: z.string().optional(),
  /** 播放数; 通常是字符串, 缺失时为 "--". */
  play: z.union([z.number(), z.string()]).optional(),
  /** 弹幕数; 通常是字符串. */
  video_review: z.union([z.number(), z.string()]).optional(),
  /** 收藏数; 通常是字符串. */
  favorites: z.union([z.number(), z.string()]).optional(),
  /** 标签, 逗号分隔字符串. */
  tag: z.string().optional(),
  /** 发布时间, Unix 秒; 真实响应可能是字符串形式的数字, 适配层转换. */
  pubdate: z.union([z.number(), z.string()]).optional(),
  /** 时长字符串, "MM:SS" 或 "H:MM:SS". */
  duration: z.string().optional(),
  /** 分区 ID; 真实响应为字符串 (2026-08 取证), 历史版本出现过 number. */
  typeid: z.union([z.number(), z.string()]).optional(),
  /** 分区名称. */
  typename: z.string().optional(),
}).passthrough();
export type RawSearchVideoItem = z.infer<typeof RawSearchVideoItemSchema>;

/**
 * 搜索响应 data 部分.
 *
 * result 刻意是 unknown[]: 平台会混入结构完全不同的特殊条目,
 * 单条校验放在适配层, 避免个别条目导致整页解析失败.
 */
export const RawSearchDataSchema = z.object({
  /** 本次搜索会话 ID. */
  seid: z.string().optional(),
  /** 平台记录的当前页码. */
  page: z.number().optional(),
  /** 平台实际使用的每页数量. */
  pagesize: z.number().optional(),
  /** 平台报告的结果总数; 只能解释为当前接口报告值, 达到上限后不可信. */
  numResults: z.number().optional(),
  /** 搜索结果列表; 空结果或被风控时可能是 null/缺失, decode 时统一归一为数组. */
  // 注意: Zod 的 .default 只在 undefined 时生效, null 会被 nullish 原样放行,
  // 因此用 transform 把 null 一并归一为 [], 让下游永远拿到数组.
  result: z.array(z.unknown()).nullish().transform((v) => v ?? []),
}).passthrough();
export type RawSearchData = z.infer<typeof RawSearchDataSchema>;

/** x/web-interface/wbi/search/type 完整响应 (envelope). */
export const RawSearchResponseSchema = z.object({
  /** 0 表示成功; -412 表示风控拦截. */
  code: z.number().int(),
  message: z.string().optional(),
  msg: z.string().optional(),
  data: RawSearchDataSchema.optional(),
}).passthrough();
export type RawSearchResponse = z.infer<typeof RawSearchResponseSchema>;

/** 解析搜索响应; 结构不符合预期时抛 ZodError, 由适配层转成稳定错误. */
export function decodeSearchResponse(rawJson: unknown): RawSearchResponse {
  return RawSearchResponseSchema.parse(rawJson);
}
