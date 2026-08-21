import type { Transcript, TranscriptSource } from "./model.js";
import { TranscriptSchema } from "./model.js";
import type { BilibiliSubtitleClient } from "../bilibili/client.js";
import { BilibiliError } from "../bilibili/errors.js";
import {
  RawSubtitleBodyItemSchema,
  RawSubtitleBodySchema,
  RawSubtitleViewSchema,
  type RawSubtitleBody,
  type RawSubtitleTrack,
  type RawSubtitleView,
} from "./bilibili-raw-schema.js";

/** Tool 层可依赖的标准化字幕轨候选；不暴露 B站原始字段名。 */
export interface SubtitleTrackCandidate {
  /** 字幕轨稳定 ID。 */
  id: string;
  /** 标准化语言代码。 */
  language: string;
  /** 可用于匹配用户输入的语言别名，由适配层统一生成。 */
  languageAliases: string[];
  /** 供用户选择时显示的语言名称。 */
  languageLabel?: string;
  /** 区分人工官方字幕与平台 AI 字幕。 */
  source: Exclude<TranscriptSource, "asr">;
  /** 当前正文格式。M1.1 只消费 srt 对应的 JSON 正文。 */
  format: "srt" | "ass";
  /** 当前轨道能否直接下载正文。 */
  accessible: boolean;
  /** 已转换并验证来源域名的正文 URL，只在适配层与 Tool 内部使用。 */
  downloadUrl?: string;
  /** 适配与排错需要的最小补充信息。 */
  metadata: Record<string, unknown>;
}

/** 字幕轨发现结果。 */
export interface DiscoverSubtitleTracksResult {
  /** 播放器报告的默认语言，经标准化后返回。 */
  preferredLanguage?: string;
  /** 标准化字幕轨列表。 */
  tracks: SubtitleTrackCandidate[];
  /** 单轨异常不会阻断其它可用轨道，通过 warnings 显式报告。 */
  warnings: string[];
}

/** 字幕正文标准化结果。 */
export interface NormalizeSubtitleBodyResult {
  /** 已通过内部模型校验的 Transcript。 */
  transcript: Transcript;
  /** 被跳过的异常片段说明。 */
  warnings: string[];
}

interface WireField {
  fieldNumber: number;
  wireType: number;
  value: bigint | Uint8Array;
}

const textDecoder = new TextDecoder();

/**
 * 读取 protobuf varint。字幕响应没有公开稳定的 JSON 契约，因此只实现当前
 * 所需的通用 wire type 读取，并跳过未知字段，减少播放器协议扩展带来的影响。
 */
function readVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;

  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, index + 1];
    shift += 7n;
  }

  throw new BilibiliError({
    code: "invalid_subtitle_view",
    message: "B站字幕轨响应包含无法解析的整数",
  });
}

/** 把一个 protobuf message 拆成字段；未知字段按 wire type 安全跳过。 */
function readWireFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const [key, afterKey] = readVarint(bytes, offset);
    offset = afterKey;
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 0x07n);

    if (fieldNumber <= 0) {
      throw new BilibiliError({
        code: "invalid_subtitle_view",
        message: "B站字幕轨响应包含非法字段编号",
      });
    }

    if (wireType === 0) {
      const [value, nextOffset] = readVarint(bytes, offset);
      fields.push({ fieldNumber, wireType, value });
      offset = nextOffset;
      continue;
    }

    if (wireType === 2) {
      const [rawLength, afterLength] = readVarint(bytes, offset);
      if (rawLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BilibiliError({
          code: "invalid_subtitle_view",
          message: "B站字幕轨响应字段长度超出可处理范围",
        });
      }
      const end = afterLength + Number(rawLength);
      if (end > bytes.length) {
        throw new BilibiliError({
          code: "invalid_subtitle_view",
          message: "B站字幕轨响应字段长度不完整",
        });
      }
      fields.push({ fieldNumber, wireType, value: bytes.slice(afterLength, end) });
      offset = end;
      continue;
    }

    // 固定 64/32 位字段当前不参与字幕映射，但仍需跳过，保证未来新增字段时可兼容。
    if (wireType === 1 || wireType === 5) {
      const byteLength = wireType === 1 ? 8 : 4;
      const end = offset + byteLength;
      if (end > bytes.length) {
        throw new BilibiliError({
          code: "invalid_subtitle_view",
          message: "B站字幕轨响应固定长度字段不完整",
        });
      }
      offset = end;
      continue;
    }

    throw new BilibiliError({
      code: "invalid_subtitle_view",
      message: `B站字幕轨响应使用了不支持的 wire type=${wireType}`,
    });
  }

  return fields;
}

function bytesField(fields: WireField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((item) => item.fieldNumber === fieldNumber && item.wireType === 2);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function stringField(fields: WireField[], fieldNumber: number): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? textDecoder.decode(bytes) : undefined;
}

function integerField(fields: WireField[], fieldNumber: number): bigint | undefined {
  const field = fields.find((item) => item.fieldNumber === fieldNumber && item.wireType === 0);
  return typeof field?.value === "bigint" ? field.value : undefined;
}

/** 将当前 `/x/v2/subtitle/web/view` 二进制响应解码为最小原始结构。 */
export function decodeSubtitleViewReply(bytes: Uint8Array): RawSubtitleView {
  try {
    const replyFields = readWireFields(bytes);
    const videoSubtitleBytes = bytesField(replyFields, 1);
    if (!videoSubtitleBytes) {
      return RawSubtitleViewSchema.parse({ subtitles: [] });
    }

    const videoFields = readWireFields(videoSubtitleBytes);
    const rawTracks: RawSubtitleTrack[] = videoFields
      .filter((field) => field.fieldNumber === 3 && field.wireType === 2)
      .map((field, index) => {
        if (!(field.value instanceof Uint8Array)) {
          throw new BilibiliError({
            code: "invalid_subtitle_view",
            message: "B站字幕轨字段不是有效二进制消息",
          });
        }
        const trackFields = readWireFields(field.value);
        const id = stringField(trackFields, 2)
          ?? integerField(trackFields, 1)?.toString()
          ?? `track-${index + 1}`;

        return {
          id,
          lan: stringField(trackFields, 3) ?? "unknown",
          lanDoc: stringField(trackFields, 4),
          subtitleUrl: stringField(trackFields, 5),
          type: integerField(trackFields, 7) === undefined
            ? undefined
            : Number(integerField(trackFields, 7)),
          lanDocBrief: stringField(trackFields, 8),
          aiStatus: integerField(trackFields, 10) === undefined
            ? undefined
            : Number(integerField(trackFields, 10)),
          format: integerField(trackFields, 13) === undefined
            ? undefined
            : Number(integerField(trackFields, 13)),
        };
      });

    return RawSubtitleViewSchema.parse({
      lan: stringField(videoFields, 1),
      lanDoc: stringField(videoFields, 2),
      subtitles: rawTracks,
    });
  } catch (error) {
    if (error instanceof BilibiliError) throw error;
    throw new BilibiliError({
      code: "invalid_subtitle_view",
      message: "B站字幕轨响应无法按当前协议解析",
      cause: error,
    });
  }
}

/** 将 B站 `ai-zh` 等来源代码转成内部通用语言标识，同时保留原值到 metadata。 */
export function normalizeSubtitleLanguage(rawLanguage: string): string {
  const withoutAiPrefix = rawLanguage.toLowerCase().startsWith("ai-")
    ? rawLanguage.slice(3)
    : rawLanguage;
  return withoutAiPrefix.replaceAll("_", "-") || "unknown";
}

const encryptedSubtitleUrlKeys: ReadonlyArray<readonly [string, string]> = [
  ["nP](wOFRvU.+<fjS{jn-!$D|Dz&\",zT`", "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`"],
  ["Bn\"q~|albg@]Go~ACgyDvKnd+)_D}^&J?", "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"],
];

function xorText(value: string, key: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    output += String.fromCharCode(
      value.charCodeAt(index) ^ key.charCodeAt(index % key.length),
    );
  }
  return output;
}

function assertTrustedSubtitleUrl(url: URL): void {
  const trustedHost = url.hostname === "aisubtitle.hdslb.com"
    || /^i\d+\.hdslb\.com$/u.test(url.hostname);

  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new BilibiliError({
      code: "untrusted_subtitle_url",
      message: "B站返回的字幕正文地址不属于允许访问的平台域名",
    });
  }
}

/**
 * 将播放器返回的字幕地址转成可请求地址，并限制到已知 B站字幕域名。
 * 加密转换只存在于适配层，上层 Tool 不感知这项平台细节。
 */
export function resolveSubtitleDownloadUrl(rawUrl: string): string {
  const normalizedRaw = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  const parsed = new URL(normalizedRaw);

  if (parsed.hostname === "subtitle.bilibili.com") {
    const encodedPath = parsed.pathname.slice(1);
    let decodedPath: string | undefined;

    for (const [prefix, rawKey] of encryptedSubtitleUrlKeys) {
      const candidate = xorText(decodeURIComponent(encodedPath), `${rawKey}bilibili`);
      if (candidate.startsWith(prefix)) {
        decodedPath = candidate.slice(prefix.length);
        break;
      }
    }

    if (!decodedPath?.startsWith("/")) {
      throw new BilibiliError({
        code: "unsupported_subtitle_url",
        message: "B站字幕正文地址使用了当前适配器无法识别的转换方式",
      });
    }

    const converted = new URL(`https://aisubtitle.hdslb.com${decodedPath}`);
    converted.search = parsed.search;
    assertTrustedSubtitleUrl(converted);
    return converted.toString();
  }

  assertTrustedSubtitleUrl(parsed);
  return parsed.toString();
}

/** 发现指定 aid/cid 的官方字幕轨，并隔离播放器协议细节。 */
export async function discoverOfficialSubtitleTracks(
  client: BilibiliSubtitleClient,
  input: { aid: string; cid: string },
): Promise<DiscoverSubtitleTracksResult> {
  const bytes = await client.getBinary("/x/v2/subtitle/web/view", {
    oid: input.cid,
    pid: input.aid,
    type: 1,
    context_ext: JSON.stringify({ video_type: 1 }),
  });
  const raw = decodeSubtitleViewReply(bytes);
  const warnings: string[] = [];

  const tracks = raw.subtitles.map((track): SubtitleTrackCandidate => {
    let downloadUrl: string | undefined;
    if (track.subtitleUrl) {
      try {
        downloadUrl = resolveSubtitleDownloadUrl(track.subtitleUrl);
      } catch (error) {
        warnings.push(
          `字幕轨 ${track.id} 的正文地址不可用：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      id: track.id,
      language: normalizeSubtitleLanguage(track.lan),
      languageAliases: Array.from(new Set([
        normalizeSubtitleLanguage(track.lan).toLowerCase(),
        track.lan.toLowerCase(),
      ])),
      languageLabel: track.lanDocBrief ?? track.lanDoc,
      source: track.type === 1 ? "official_ai" : "official",
      format: track.format === 1 ? "ass" : "srt",
      accessible: downloadUrl !== undefined,
      downloadUrl,
      metadata: {
        sourceLanguageCode: track.lan,
        aiStatus: track.aiStatus,
      },
    };
  });

  return {
    preferredLanguage: raw.lan ? normalizeSubtitleLanguage(raw.lan) : undefined,
    tracks,
    warnings,
  };
}

/** 下载单条字幕轨的 JSON 正文。URL 已在发现阶段完成域名校验。 */
export async function fetchOfficialSubtitleBody(
  client: BilibiliSubtitleClient,
  track: SubtitleTrackCandidate,
): Promise<RawSubtitleBody> {
  if (!track.downloadUrl) {
    throw new BilibiliError({
      code: "subtitle_body_unavailable",
      message: "所选字幕轨没有可用的正文地址",
    });
  }
  if (track.format !== "srt") {
    throw new BilibiliError({
      code: "unsupported_subtitle_format",
      message: `当前 M1.1 尚不支持 ${track.format.toUpperCase()} 字幕正文`,
    });
  }

  // 在实际请求前再次校验，避免未来调用方绕过发现阶段直接构造候选。
  const trustedUrl = resolveSubtitleDownloadUrl(track.downloadUrl);
  return client.getJsonFromUrl(trustedUrl, RawSubtitleBodySchema);
}

/** 把 B站正文片段转换为带时间范围的内部 Transcript。 */
export function normalizeOfficialSubtitleBody(
  body: RawSubtitleBody,
  track: SubtitleTrackCandidate,
  cid: string,
): NormalizeSubtitleBodyResult {
  const warnings: string[] = [];
  const segments = body.body.flatMap((rawItem, index) => {
    const parsed = RawSubtitleBodyItemSchema.safeParse(rawItem);
    if (!parsed.success || parsed.data.content.trim().length === 0) {
      warnings.push(`字幕正文第 ${index + 1} 条无效，已跳过`);
      return [];
    }

    return [{
      id: `subtitle:${cid}:${track.id}:${index + 1}`,
      startSeconds: parsed.data.from,
      endSeconds: parsed.data.to,
      text: parsed.data.content,
      metadata: {
        sourceIndex: index,
      },
    }];
  }).sort((left, right) => left.startSeconds - right.startSeconds);

  if (body.body.length > 0 && segments.length === 0) {
    throw new BilibiliError({
      code: "invalid_subtitle_body",
      message: "B站字幕正文存在数据，但没有可用的时间片段",
    });
  }

  const transcript = TranscriptSchema.parse({
    source: track.source,
    language: track.language,
    cid,
    provider: "bilibili",
    segments,
    complete: warnings.length === 0,
    metadata: {
      subtitleTrackId: track.id,
      languageLabel: track.languageLabel,
      format: track.format,
      ...track.metadata,
    },
  });

  return { transcript, warnings };
}
