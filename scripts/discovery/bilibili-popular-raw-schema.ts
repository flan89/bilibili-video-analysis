/**
 * scripts/discovery/bilibili-popular-raw-schema.ts: B 站当前热门接口原始字段 schema.
 *
 * 协议: x/web-interface/popular (无需 WBI 签名, 但必须携带普通 Web User-Agent
 * 和热门页面 Referer, 否则实测会返回业务 -352 风控).
 *
 * 平台特性 (2026-08 真实响应取证):
 * - 条目是视频详情卡片形态 (与 view 接口同源), 不是搜索结果形态:
 *   duration 是秒数值, 统计在 stat 对象里, 标题不带高亮标记;
 * - 推荐理由 rcmd_reason 是对象 {content, corner_mark}, content 可以是空字符串;
 *   历史或其它形态下可能是纯字符串, schema 同时接受两种;
 * - aid 可能超出 Number.MAX_SAFE_INTEGER, 视频身份一律以 bvid 为准;
 * - data 里有 no_more 表示热门列表是否已到底, 比搜索接口的满页估计更可靠;
 * - 列表里可能混入 OGV (番剧/影视) 条目 (is_ogv=true), 但只要带 bvid 仍按视频候选处理.
 *
 * D12 边界: 本文件只描述 B 站原始响应结构, 业务标准化在 bilibili-popular-adapter.ts 完成.
 */
import { z } from "zod";

/** 推荐理由原始形态: 当前真实响应为对象, 历史形态可能是纯字符串. */
export const RawPopularReasonSchema = z.union([
  z.string(),
  z.object({
    /** 理由文本, 例如"百万播放"; 可能为空字符串. */
    content: z.string().optional(),
    /** 角标类型; 仅原样保留, 不参与业务判断. */
    corner_mark: z.number().optional(),
  }).passthrough(),
]);
export type RawPopularReason = z.infer<typeof RawPopularReasonSchema>;

/** 热门条目作者信息原始形态. */
export const RawPopularOwnerSchema = z.object({
  /** UP 主 mid; 可能超出安全整数, 统一以字符串保留. */
  mid: z.union([z.number(), z.string()]).optional(),
  /** UP 主昵称. */
  name: z.string().optional(),
  /** UP 主头像地址. */
  face: z.string().optional(),
}).passthrough();
export type RawPopularOwner = z.infer<typeof RawPopularOwnerSchema>;

/** 热门条目统计信息原始形态; 数值字段接受 number | string 以兼容平台变化. */
export const RawPopularStatSchema = z.object({
  /** 播放量. */
  view: z.union([z.number(), z.string()]).optional(),
  /** 弹幕数. */
  danmaku: z.union([z.number(), z.string()]).optional(),
  /** 收藏数. */
  favorite: z.union([z.number(), z.string()]).optional(),
  /** 点赞数. */
  like: z.union([z.number(), z.string()]).optional(),
  /** 评论数. */
  reply: z.union([z.number(), z.string()]).optional(),
  /** 投币数. */
  coin: z.union([z.number(), z.string()]).optional(),
  /** 分享数. */
  share: z.union([z.number(), z.string()]).optional(),
}).passthrough();
export type RawPopularStat = z.infer<typeof RawPopularStatSchema>;

/**
 * 单条热门视频原始条目.
 * 字段大量可选: 平台可能缺失个别字段, 适配层负责保守处理.
 */
export const RawPopularVideoItemSchema = z.object({
  /** BV 号; 热门列表真实响应必带, 缺失时该条目无法定位身份. */
  bvid: z.string().optional(),
  /** 稿件 aid; 可能超出安全整数, 不参与业务身份. */
  aid: z.union([z.number(), z.string()]).optional(),
  /** 标题; 不带高亮标记. 真实响应必带, 缺失视为条目结构异常. */
  title: z.string(),
  /** 简介. */
  desc: z.string().optional(),
  /** 封面地址, 通常为 http(s) 绝对地址. */
  pic: z.string().optional(),
  /** 时长, 秒; 真实响应为数值 (与搜索接口的 "MM:SS" 字符串不同). */
  duration: z.union([z.number(), z.string()]).optional(),
  /** 发布时间, Unix 秒. */
  pubdate: z.union([z.number(), z.string()]).optional(),
  /** 分区 ID. */
  tid: z.union([z.number(), z.string()]).optional(),
  /** 分区名称, 例如"网络游戏". */
  tname: z.string().optional(),
  /** 作者信息. */
  owner: RawPopularOwnerSchema.optional(),
  /** 统计信息. */
  stat: RawPopularStatSchema.optional(),
  /** 平台热门推荐理由; content 可能为空字符串. */
  rcmd_reason: RawPopularReasonSchema.optional(),
  /** 是否为 OGV (番剧/影视等) 条目; 原样保留供 Agent 参考, 不过滤. */
  is_ogv: z.boolean().optional(),
}).passthrough();
export type RawPopularVideoItem = z.infer<typeof RawPopularVideoItemSchema>;

/**
 * 热门响应 data 部分.
 *
 * list 刻意是 unknown[]: 平台可能混入结构不同的条目 (例如 OGV 卡片),
 * 单条校验放在适配层, 避免个别条目导致整页解析失败.
 */
export const RawPopularDataSchema = z.object({
  /** 热门列表; 空列表或被风控时可能是 null/缺失, decode 时统一归一为数组. */
  // 注意: Zod 的 .default 只在 undefined 时生效, null 会被 nullish 原样放行,
  // 因此用 transform 把 null 一并归一为 [], 让下游永远拿到数组.
  list: z.array(z.unknown()).nullish().transform((v) => v ?? []),
  /** 是否已无更多热门条目; true 时 hasNextPage 必须为 false. */
  no_more: z.boolean().optional(),
}).passthrough();
export type RawPopularData = z.infer<typeof RawPopularDataSchema>;

/** x/web-interface/popular 完整响应 (envelope). */
export const RawPopularResponseSchema = z.object({
  /** 0 表示成功; -352 表示风控拦截 (常见于缺少 UA/Referer 请求头). */
  code: z.number().int(),
  message: z.string().optional(),
  data: RawPopularDataSchema.optional(),
}).passthrough();
export type RawPopularResponse = z.infer<typeof RawPopularResponseSchema>;

/** 解析热门响应; 结构不符合预期时抛 ZodError, 由适配层转成稳定错误. */
export function decodePopularResponse(rawJson: unknown): RawPopularResponse {
  return RawPopularResponseSchema.parse(rawJson);
}
