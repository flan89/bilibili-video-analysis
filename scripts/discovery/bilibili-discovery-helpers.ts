/**
 * scripts/discovery/bilibili-discovery-helpers.ts: 发现来源共享的确定性小工具.
 *
 * 只收录两个及以上发现来源确实复用、且语义完全相同的 helper (AGENTS_M8 §11):
 * - BV 号最小校验;
 * - 协议相对地址规范化;
 * - 平台数值 (number | 字符串形式数字 | "--") 转非负整数.
 *
 * 各来源专属的清理逻辑 (搜索高亮 / 时长字符串解析等) 仍留在各自 adapter,
 * 不为了减少几行代码建立通用 DiscoveryAdapter.
 */

/** BV 号最小格式校验, 与 bilibili/url.ts 保持一致. */
export const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

/**
 * 协议相对地址 ("//i0.hdslb.com/...") → https 绝对地址.
 * 已是 http(s) 的原样返回; 无法规范化的返回 undefined.
 */
export function normalizeProtocolRelativeUrl(url: string): string | undefined {
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return undefined;
}

/**
 * 把平台数值字段 (number | 字符串形式数字, 例如搜索接口的 "--" 占位)
 * 转成非负整数; 无法解析返回 undefined.
 */
export function toCount(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
