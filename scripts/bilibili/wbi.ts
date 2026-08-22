/**
 * scripts/bilibili/wbi.ts: B 站 WBI (Web Broadcast Interface) 签名.
 *
 * 用途: 给 x/v2/reply/wbi/main 等新版 B 站接口签名, 不签名会被 -403 拒绝.
 *
 * 算法 (参考 JSR @one2x/mebox-extractor 实现, 5 步):
 *   1. mixin_key = (img_key + sub_key) 按 64 元素编码表打乱取前 32 字符
 *   2. 加 wts = 当前 Unix 秒
 *   3. 过滤特殊字符: /[!'()*]/g
 *   4. 按 key 排序 + encodeURIComponent
 *   5. MD5(query + mixin_key) → w_rid
 *
 * D12 边界: 本文件只处理 B 站 WBI 签名机制, 不混入业务逻辑. 跟字幕/弹幕
 * 平台适配一样, 平台细节锁在这里, 业务层 (comments-adapter) 只调 signWbiRequest.
 *
 * 实测: 2026-08-18 跑通, BV1WMgp6aEND 匿名拿 wbi_img, 签 x/v2/reply/wbi/main
 *       (虽然 datacenter IP 仍被限流到 3 条置顶, 但 w_rid 校验通过, code != -403).
 */
import crypto from "node:crypto";

import { z } from "zod";

import { BilibiliError } from "./errors.js";
import type { BilibiliApiClient } from "./client.js";

/**
 * B 站 mixin_key 编码表, 64 个索引.
 * 用于从 (img_key + sub_key) 拼接字符串中按索引取字符, 生成 32 字符 mixin_key.
 *
 * 来源: B 站前端 JS (socialsisteryi/bilibili-API-collect 文档原表),
 *       多年未变, 直接硬编码.
 */
export const MIXIN_KEY_ENCODING_TAB: readonly number[] = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]);

/** B 站 WBI 特殊字符过滤正则. */
const WBI_CHR_FILTER = /[!'()*]/g;

/** WBI 密钥接口请求超时; 与 BilibiliClient 默认值保持一致. */
const WBI_KEYS_TIMEOUT_MS = 15_000;

/**
 * 从 (img_key + sub_key) 拼接字符串生成 32 字符 mixin_key.
 *
 * 规则: 按 MIXIN_KEY_ENCODING_TAB 的 64 个索引依次取字符, 拼成新串, 取前 32 字符.
 *
 * @example
 *   getMixinKey("7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45")
 *   // → 固定 32 字符
 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  if (orig.length < 64) {
    // 实际不会触发, B 站 img_key / sub_key 都是 32 字符 MD5.
    throw new BilibiliError({
      code: "wbi_key_too_short",
      message: `img_key + sub_key 长度 ${orig.length} 不足 64, 无法生成 mixin_key`,
    });
  }
  let result = "";
  for (const idx of MIXIN_KEY_ENCODING_TAB) {
    result += orig[idx] ?? "";
  }
  return result.slice(0, 32);
}

/**
 * Node 端 MD5 摘要 (16 字节 → 32 字符 hex).
 * 用 node:crypto 跟浏览器 SubtleCrypto 接口分离, 业务层调用时不用关心.
 */
function md5Hex(input: string): string {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * 给 B 站 WBI 接口的参数对象签名, 返回完整 query string (含 wts + w_rid).
 *
 * 处理步骤:
 *   1. 加 wts = 当前 Unix 秒
 *   2. 过滤每个 value 的特殊字符 /[!'()*]/g
 *   3. 按 key 排序, URL encode key + value
 *   4. 拼成 query string
 *   5. MD5(query + mixin_key) 作为 w_rid 追加
 *
 * 业务层调用方式:
 *   const signed = encodeWbi({ oid: 123, type: 1, mode: 3 }, imgKey, subKey);
 *   // 然后把 signed 作为 query 给 B 站接口
 */
export function encodeWbi(
  params: Record<string, string | number | boolean | undefined>,
  imgKey: string,
  subKey: string,
): string {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);

  // 步骤 1+2: 加 wts + 过滤特殊字符
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    filtered[k] = String(v).replace(WBI_CHR_FILTER, "");
  }
  filtered.wts = String(wts);

  // 步骤 3+4: 按 key 排序 + URL encode + 拼接
  const query = Object.keys(filtered)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k] ?? "")}`)
    .join("&");

  // 步骤 5: MD5 签名
  const wRid = md5Hex(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

/**
 * x/web-interface/nav 返回的 wbi_img 数据 schema.
 * B 站对 wbi 密钥接口几乎不限制, 匿名就能拿.
 */
export const WbiImgSchema = z.object({
  img_url: z.string(),
  sub_url: z.string(),
});
export type WbiImg = z.infer<typeof WbiImgSchema>;

export const NavWbiResponseSchema = z.object({
  code: z.number(),
  data: z
    .object({
      wbi_img: WbiImgSchema.optional(),
      isLogin: z.boolean().optional(),
    })
    .optional(),
});
export type NavWbiResponse = z.infer<typeof NavWbiResponseSchema>;

/**
 * 从 wbi_img URL 提取 img_key / sub_key.
 *
 * URL 形如:
 *   https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
 *   https://i0.hdslb.com/bbi/sub/4932caff0ff746eab6f01bf08b70ac45.png
 *
 * 提取规则: 最后一段去掉扩展名 (.png).
 */
export function extractWbiKeysFromImgUrls(imgUrl: string, subUrl: string): {
  imgKey: string;
  subKey: string;
} {
  return {
    imgKey: imgUrl.slice(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf(".")),
    subKey: subUrl.slice(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf(".")),
  };
}

/**
 * WBI 签名器: 内部缓存 wbi_img 减少 nav 接口调用.
 *
 * B 站 wbi_img 几天到几周更新一次, 实际工程上 1 小时 TTL 足够.
 * 缓存 key 留空: 项目进程内全局共用, 重新打开进程自然失效.
 *
 * 实现细节: 走自己内部的 fetchJson, 不用 BilibiliClient.getApiData.
 * 原因: wbi 密钥接口匿名调用返 envelope.code = -101 (未登录),
 * 但 data.wbi_img 仍然存在, 不应该被 envelope 严格检查抛错.
 * 这是 wbi 平台的特性, 平台细节锁在本类.
 */
export class WbiSigner {
  private cached: { imgKey: string; subKey: string; expiresAt: number } | null = null;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly cookie?: string;

  constructor(options: {
    cacheTtlMs?: number;
    fetchImpl?: typeof fetch;
    userAgent?: string;
    cookie?: string;
  } = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1000; // 默认 1 小时
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent
      ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
    this.cookie = options.cookie;
  }

  /**
   * 拿当前 wbi keys (缓存优先, 过期再拉).
   */
  async getKeys(_client?: BilibiliApiClient): Promise<{ imgKey: string; subKey: string }> {
    const now = Date.now();
    if (this.cached !== null && this.cached.expiresAt > now) {
      return { imgKey: this.cached.imgKey, subKey: this.cached.subKey };
    }
    // 与 BilibiliClient 一致的超时控制: nav 请求失败/挂起不应阻塞签名调用方.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WBI_KEYS_TIMEOUT_MS);
    let r: Response;
    try {
      r = await this.fetchImpl("https://api.bilibili.com/x/web-interface/nav", {
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      throw new BilibiliError({
        code: "wbi_keys_http_error",
        message: `x/web-interface/nav HTTP ${r.status}`,
        httpStatus: r.status,
        // 密钥获取是环境性问题, 稍后重试可能恢复.
        retryable: true,
      });
    }
    const raw = await r.json() as unknown;
    const nav = NavWbiResponseSchema.safeParse(raw);
    if (!nav.success) {
      throw new BilibiliError({
        code: "wbi_keys_parse_error",
        message: "x/web-interface/nav 返 JSON 跟 schema 不匹配",
        retryable: true,
        cause: nav.error,
      });
    }
    const wbiImg = nav.data.data?.wbi_img;
    if (!wbiImg) {
      throw new BilibiliError({
        code: "wbi_keys_unavailable",
        message: "x/web-interface/nav 返 wbi_img 缺失, 拿不到 WBI 签名密钥",
        apiCode: nav.data.code,
        retryable: true,
      });
    }
    const keys = extractWbiKeysFromImgUrls(wbiImg.img_url, wbiImg.sub_url);
    this.cached = {
      imgKey: keys.imgKey,
      subKey: keys.subKey,
      expiresAt: now + this.cacheTtlMs,
    };
    return keys;
  }

  /**
   * 一次完成: 拿 keys + 签名.
   */
  async signRequest(
    client: BilibiliApiClient | undefined,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<string> {
    const { imgKey, subKey } = await this.getKeys(client);
    return encodeWbi(params, imgKey, subKey);
  }

  /** 清缓存 (测试用 + 强制刷新). */
  reset(): void {
    this.cached = null;
  }
}
