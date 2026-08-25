/**
 * scripts/discovery/bilibili-related-raw-schema.ts: B 站关联推荐接口原始字段 schema.
 *
 * 协议: x/web-interface/archive/related?bvid=<BV> (或 aid=<aid>), 无需 WBI 签名;
 * 2026-08 真实取证: 缺少 UA/Referer 也能返回, 但适配层仍统一携带普通 Web 请求头.
 *
 * 平台特性 (2026-08 真实响应取证):
 * - 单次返回固定 40 条左右, 没有任何分页参数与分页契约 (AGENTS_M8 §10.2);
 * - envelope 的 data 直接是视频详情卡片数组 (与 view 接口同源), 没有外层 list 包裹;
 *   成功时 envelope 不带 ttl, 失败响应 (如 code=-400) 会带 ttl=1;
 * - 条目是详情卡片形态: duration 是秒数值, 统计在 stat 对象里, 标题不带高亮标记;
 * - rcmd_reason 实测恒为空字符串, 该接口不返回推荐理由文本 (与热门接口不同);
 * - 可能混入 OGV (番剧/影视) 条目: 带 redirect_url 指向 bangumi 页面且没有 bvid;
 * - aid 可能超出 Number.MAX_SAFE_INTEGER, 视频身份一律以 bvid 为准.
 *
 * D12 边界: 本文件只描述 B 站原始响应结构, 业务标准化在 bilibili-related-adapter.ts 完成.
 */
import { z } from "zod";

/** 关联条目作者信息原始形态. */
export const RawRelatedOwnerSchema = z.object({
  /** UP 主 mid; 可能超出安全整数, 统一以字符串保留. */
  mid: z.union([z.number(), z.string()]).optional(),
  /** UP 主昵称. */
  name: z.string().optional(),
  /** UP 主头像地址. */
  face: z.string().optional(),
}).passthrough();
export type RawRelatedOwner = z.infer<typeof RawRelatedOwnerSchema>;

/** 关联条目统计信息原始形态; 数值字段接受 number | string 以兼容平台变化. */
export const RawRelatedStatSchema = z.object({
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
export type RawRelatedStat = z.infer<typeof RawRelatedStatSchema>;

/**
 * 单条关联视频原始条目.
 * 字段大量可选: 平台可能缺失个别字段, 适配层负责保守处理.
 */
export const RawRelatedVideoItemSchema = z.object({
  /** BV 号; OGV 条目可能缺失, 缺失时该条目无法定位视频身份. */
  bvid: z.string().optional(),
  /** 稿件 aid; 可能超出安全整数, 不参与业务身份. */
  aid: z.union([z.number(), z.string()]).optional(),
  /** 标题; 不带高亮标记. 真实响应必带, 缺失视为条目结构异常 (由 safeParse 计数). */
  title: z.string(),
  /** 简介; 实测可能为空字符串. */
  desc: z.string().optional(),
  /** 封面地址, 实测为 http 绝对地址. */
  pic: z.string().optional(),
  /** 时长, 秒; 真实响应为数值. */
  duration: z.union([z.number(), z.string()]).optional(),
  /** 发布时间, Unix 秒. */
  pubdate: z.union([z.number(), z.string()]).optional(),
  /** 分区 ID. */
  tid: z.union([z.number(), z.string()]).optional(),
  /** 分区名称, 例如"三农". */
  tname: z.string().optional(),
  /** 作者信息. */
  owner: RawRelatedOwnerSchema.optional(),
  /** 统计信息. */
  stat: RawRelatedStatSchema.optional(),
  /** 推荐理由; 实测恒为空字符串, schema 仍保留以兼容平台变化. */
  rcmd_reason: z.string().optional(),
  /** 是否为 OGV (番剧/影视等) 条目; 原样保留供适配层判断与 Agent 参考. */
  is_ogv: z.boolean().optional(),
  /** OGV 条目的跳转地址 (bangumi 播放页); 出现时通常没有 bvid. */
  redirect_url: z.string().optional(),
}).passthrough();
export type RawRelatedVideoItem = z.infer<typeof RawRelatedVideoItemSchema>;

/**
 * x/web-interface/archive/related 完整响应 (envelope).
 *
 * data 直接是条目数组: 刻意是 unknown[], 平台可能混入结构不同的条目 (OGV 卡片),
 * 单条校验放在适配层, 避免个别条目导致整体解析失败.
 */
export const RawRelatedResponseSchema = z.object({
  /** 0 表示成功; -400 表示 bvid/aid 缺失或无效 (实测); -352/-412 为风控码. */
  code: z.number().int(),
  message: z.string().optional(),
  // 注意: Zod 的 .default 只在 undefined 时生效, null 会被 nullish 原样放行,
  // 因此用 transform 把 null 一并归一为 [], 让下游永远拿到数组.
  data: z.array(z.unknown()).nullish().transform((v) => v ?? []),
}).passthrough();
export type RawRelatedResponse = z.infer<typeof RawRelatedResponseSchema>;

/** 解析关联推荐响应; 结构不符合预期时抛 ZodError, 由适配层转成稳定错误. */
export function decodeRelatedResponse(rawJson: unknown): RawRelatedResponse {
  return RawRelatedResponseSchema.parse(rawJson);
}
