import { z } from "zod";
import { BilibiliError } from "./errors.js";
import { BilibiliApiEnvelopeSchema } from "./raw-schemas.js";

/** 供 Metadata/Subtitle/Comment 等模块共同依赖的最小 Client 契约。 */
export interface BilibiliApiClient {
  /**
   * 调用 B站 JSON API，并把 envelope 中的 data 交给指定 Zod Schema 校验。
   * 这样上层永远拿到“已验证的数据”，而不是 unknown JSON。
   */
  getApiData<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
  ): Promise<T>;

  /**
   * 解析短链最终跳转地址。普通 www.bilibili.com URL 不需要调用。
   */
  resolveFinalUrl(url: string): Promise<string>;
}

/**
 * 官方字幕链路需要的扩展 Client 契约。
 *
 * 当前字幕轨发现接口返回 protobuf（二进制协议），字幕正文则是一个不带 B站
 * envelope 的独立 JSON，因此不能复用 `getApiData`。
 */
export interface BilibiliSubtitleClient extends BilibiliApiClient {
  /** 调用 B站二进制接口并返回原始字节。 */
  getBinary(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<Uint8Array>;

  /** 获取已经过字幕适配层安全校验的正文 URL，并使用指定 Schema 校验。 */
  getJsonFromUrl<T>(url: string, schema: z.ZodType<T>): Promise<T>;
}

/** Client 可配置项。后续登录态、代理、重试都可以在这一层继续扩展。 */
export interface BilibiliClientOptions {
  /** API 根地址；默认使用 api.bilibili.com，测试可替换。 */
  baseUrl?: string;
  /** 单次请求超时，默认 15 秒。 */
  timeoutMs?: number;
  /** 自定义 User-Agent；默认使用普通浏览器 UA，避免服务端拒绝无 UA 请求。 */
  userAgent?: string;
  /** 可选 Cookie；V0.3 metadata 不要求登录，但后续部分接口可能需要。 */
  cookie?: string;
  /** 注入 fetch，便于完全离线的单元测试。 */
  fetchImpl?: typeof fetch;
}

/** B站 HTTP/JSON 基础客户端。 */
export class BilibiliClient implements BilibiliSubtitleClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly cookie?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BilibiliClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.bilibili.com/";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent
      ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
    this.cookie = options.cookie;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getApiData<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const raw = await this.fetchJson(url);
    const envelopeResult = BilibiliApiEnvelopeSchema.safeParse(raw);
    if (!envelopeResult.success) {
      throw new BilibiliError({
        code: "invalid_api_envelope",
        message: "B站接口返回结构无法识别",
        cause: envelopeResult.error,
      });
    }

    const envelope = envelopeResult.data;
    if (envelope.code !== 0) {
      throw new BilibiliError({
        code: "bilibili_api_error",
        message: envelope.message ?? envelope.msg ?? `B站接口返回错误 code=${envelope.code}`,
        apiCode: envelope.code,
        retryable: envelope.code === -412 || envelope.code === -509,
      });
    }

    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      throw new BilibiliError({
        code: "invalid_api_data",
        message: "B站接口 data 字段与当前适配器预期不一致",
        cause: parsed.error,
      });
    }

    return parsed.data;
  }

  async getBinary(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<Uint8Array> {
    const url = this.buildUrl(path, query);
    return this.fetchResponse(
      url,
      async (response) => new Uint8Array(await response.arrayBuffer()),
      "application/octet-stream, */*",
    );
  }

  async getJsonFromUrl<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    return this.fetchResponse(new URL(url), async (response) => {
      let raw: unknown;

      try {
        raw = await response.json();
      } catch (error) {
        throw new BilibiliError({
          code: "invalid_json",
          message: "B站字幕正文没有返回有效 JSON",
          httpStatus: response.status,
          cause: error,
        });
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new BilibiliError({
          code: "invalid_subtitle_body",
          message: "B站字幕正文结构与当前适配器预期不一致",
          cause: parsed.error,
        });
      }

      return parsed.data;
    });
  }

  async resolveFinalUrl(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        throw new BilibiliError({
          code: "short_url_http_error",
          message: `B站短链解析失败，HTTP ${response.status}`,
          httpStatus: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }

      return response.url || url;
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new BilibiliError({
          code: "request_timeout",
          message: `B站短链解析超时（${this.timeoutMs}ms）`,
          retryable: true,
          cause: error,
        });
      }
      throw new BilibiliError({
        code: "network_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJson(url: URL): Promise<unknown> {
    return this.fetchResponse(url, async (response) => {
      try {
        return await response.json();
      } catch (error) {
        throw new BilibiliError({
          code: "invalid_json",
          message: "B站接口没有返回有效 JSON",
          httpStatus: response.status,
          cause: error,
        });
      }
    });
  }

  private buildUrl(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async fetchResponse<T>(
    url: URL,
    readBody: (response: Response) => Promise<T>,
    accept?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: this.buildHeaders(accept),
      });

      if (!response.ok) {
        throw new BilibiliError({
          code: "http_error",
          message: `B站接口请求失败，HTTP ${response.status}`,
          httpStatus: response.status,
          // 412 是B站风控拦截: retryable=true 只表示稍后重试可能有意义,
          // 调用方 (Agent) 不应立即连续重试 (M7 §6.5).
          retryable: response.status >= 500 || response.status === 429 || response.status === 412,
        });
      }

      return await readBody(response);
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new BilibiliError({
          code: "request_timeout",
          message: `B站接口请求超时（${this.timeoutMs}ms）`,
          retryable: true,
          cause: error,
        });
      }
      throw new BilibiliError({
        code: "network_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(accept = "application/json, text/plain, */*"): Record<string, string> {
    const headers: Record<string, string> = {
      accept,
      "user-agent": this.userAgent,
      referer: "https://www.bilibili.com/",
    };

    if (this.cookie) {
      headers.cookie = this.cookie;
    }

    return headers;
  }
}
