import { BilibiliError } from "./errors.js";
import type { BilibiliApiClient } from "./client.js";

/** BV 号目前按 `BV + 10位字母数字` 做最小格式校验。 */
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
/** AV 号接受 `av123` 形式；不把纯数字默认解释为 aid，避免输入语义歧义。 */
const AVID_PATTERN = /^av(\d+)$/i;

/** 解析 URL 中具有业务语义的分P编号；其它查询参数不会进入标准结果。 */
function parseRequestedPage(url: URL): number | undefined {
  const rawPage = url.searchParams.get("p");
  if (rawPage === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(rawPage)) {
    throw new BilibiliError({
      code: "invalid_video_page",
      message: `分P参数 p 必须是从 1 开始的整数，收到：${rawPage}`,
    });
  }
  const requestedPage = Number(rawPage);
  if (!Number.isSafeInteger(requestedPage)) {
    throw new BilibiliError({
      code: "invalid_video_page",
      message: `分P参数 p 超出安全整数范围，收到：${rawPage}`,
    });
  }
  return requestedPage;
}

function makeCanonicalUrl(videoToken: string, requestedPage?: number): string {
  const base = `https://www.bilibili.com/video/${videoToken}/`;
  return requestedPage === undefined ? base : `${base}?p=${requestedPage}`;
}

/** URL/Input 解析后的标准视频标识。 */
export type ParsedBilibiliVideoInput =
  | {
      /** 使用 BV 号定位视频。 */
      kind: "bvid";
      bvid: string;
      /** 去掉无关查询参数后的标准视频 URL。 */
      canonicalUrl: string;
      /** 用户通过 URL 的 p 参数指定的自然分P编号。 */
      requestedPage?: number;
      /** 用户原始输入，用于调试与错误提示。 */
      originalInput: string;
    }
  | {
      /** 使用 AV aid 定位视频。 */
      kind: "aid";
      aid: string;
      canonicalUrl: string;
      requestedPage?: number;
      originalInput: string;
    }
  | {
      /** b23.tv 等短链，需要先发起一次重定向解析。 */
      kind: "short_url";
      url: string;
      originalInput: string;
    };

/**
 * 只做“纯字符串解析”，不访问网络。
 * 短链会返回 short_url，交给 resolveBilibiliVideoInput 再解析。
 */
export function parseBilibiliVideoInput(input: string): ParsedBilibiliVideoInput {
  const raw = input.trim();
  if (!raw) {
    throw new BilibiliError({
      code: "empty_video_input",
      message: "视频输入不能为空",
    });
  }

  if (BVID_PATTERN.test(raw)) {
    return {
      kind: "bvid",
      bvid: raw,
      canonicalUrl: `https://www.bilibili.com/video/${raw}/`,
      originalInput: input,
    };
  }

  const avMatch = raw.match(AVID_PATTERN);
  if (avMatch?.[1]) {
    return {
      kind: "aid",
      aid: avMatch[1],
      canonicalUrl: `https://www.bilibili.com/video/av${avMatch[1]}/`,
      originalInput: input,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new BilibiliError({
      code: "invalid_video_input",
      message: "输入不符合当前支持的 B站视频 URL、BV号或 av号格式；尚未向B站发起请求",
      cause: error,
    });
  }

  const host = url.hostname.toLowerCase();
  if (host === "b23.tv" || host.endsWith(".b23.tv")) {
    return {
      kind: "short_url",
      url: url.toString(),
      originalInput: input,
    };
  }

  if (!(host === "bilibili.com" || host.endsWith(".bilibili.com"))) {
    throw new BilibiliError({
      code: "unsupported_video_host",
      message: `当前只支持 B站域名，收到：${host}`,
    });
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const videoIndex = parts.findIndex((part) => part.toLowerCase() === "video");
  const videoToken = videoIndex >= 0 ? parts[videoIndex + 1] : undefined;
  const requestedPage = parseRequestedPage(url);

  if (videoToken && BVID_PATTERN.test(videoToken)) {
    return {
      kind: "bvid",
      bvid: videoToken,
      canonicalUrl: makeCanonicalUrl(videoToken, requestedPage),
      requestedPage,
      originalInput: input,
    };
  }

  const avUrlMatch = videoToken?.match(AVID_PATTERN);
  if (avUrlMatch?.[1]) {
    return {
      kind: "aid",
      aid: avUrlMatch[1],
      canonicalUrl: makeCanonicalUrl(`av${avUrlMatch[1]}`, requestedPage),
      requestedPage,
      originalInput: input,
    };
  }

  throw new BilibiliError({
    code: "unsupported_bilibili_url",
    message: "B站 URL 中没有识别到 BV/AV 视频标识",
  });
}

/**
 * 解析输入并在必要时展开短链。
 * 为避免无限跳转，短链解析后只再执行一次纯解析，不递归继续请求短链。
 */
export async function resolveBilibiliVideoInput(
  input: string,
  client: BilibiliApiClient,
): Promise<Exclude<ParsedBilibiliVideoInput, { kind: "short_url" }>> {
  const parsed = parseBilibiliVideoInput(input);
  if (parsed.kind !== "short_url") {
    return parsed;
  }

  const finalUrl = await client.resolveFinalUrl(parsed.url);
  const resolved = parseBilibiliVideoInput(finalUrl);
  if (resolved.kind === "short_url") {
    throw new BilibiliError({
      code: "short_url_not_resolved",
      message: "B站短链重定向后仍未得到可识别的视频 URL",
    });
  }

  return resolved;
}
