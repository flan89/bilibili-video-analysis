import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RawSubtitleBodySchema,
  RawSubtitleViewSchema,
} from "../../scripts/subtitle/bilibili-raw-schema.js";
import {
  decodeSubtitleViewReply,
  normalizeOfficialSubtitleBody,
  resolveSubtitleDownloadUrl,
  type SubtitleTrackCandidate,
} from "../../scripts/subtitle/bilibili-adapter.js";
import { encodeSubtitleViewFixture } from "../helpers/subtitle-protobuf.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

function xorText(value: string, key: string): string {
  return Array.from(value, (character, index) => String.fromCharCode(
    character.charCodeAt(0) ^ key.charCodeAt(index % key.length),
  )).join("");
}

const track: SubtitleTrackCandidate = {
  id: "10001",
  language: "zh",
  languageAliases: ["zh", "ai-zh"],
  languageLabel: "中文",
  source: "official_ai",
  format: "srt",
  accessible: true,
  downloadUrl: "https://aisubtitle.hdslb.com/bfs/subtitle/example.json",
  metadata: { sourceLanguageCode: "ai-zh" },
};

describe("官方字幕适配器", () => {
  it("解码播放器 protobuf 字幕轨并保留超大字符串 ID", () => {
    const raw = RawSubtitleViewSchema.parse(fixture("subtitle-view-single.json"));
    const decoded = decodeSubtitleViewReply(encodeSubtitleViewFixture(raw));

    expect(decoded.lan).toBe("zh-CN");
    expect(decoded.subtitles).toHaveLength(1);
    expect(decoded.subtitles[0]?.id).toBe("9007199254740993");
    expect(decoded.subtitles[0]?.lanDocBrief).toBe("中文");
  });

  it("把播放器加密地址转换为受信任的字幕正文地址", () => {
    const prefix = "nP](wOFRvU.+<fjS{jn-!$D|Dz&\",zT`";
    const key = "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`bilibili";
    const encryptedPath = encodeURIComponent(xorText(`${prefix}/bfs/subtitle/test.json`, key));
    const rawUrl = `//subtitle.bilibili.com/${encryptedPath}?auth_key=test`;

    expect(resolveSubtitleDownloadUrl(rawUrl)).toBe(
      "https://aisubtitle.hdslb.com/bfs/subtitle/test.json?auth_key=test",
    );
  });

  it("标准化正文时保留时间戳并按开始时间排序", () => {
    const body = RawSubtitleBodySchema.parse(fixture("subtitle-body.json"));
    const result = normalizeOfficialSubtitleBody(body, track, "cid-1");

    expect(result.transcript.source).toBe("official_ai");
    expect(result.transcript.cid).toBe("cid-1");
    expect(result.transcript.segments[0]).toMatchObject({
      startSeconds: 0.5,
      endSeconds: 2.3,
      text: "大家好，今天介绍这个方法。",
    });
    expect(result.transcript.complete).toBe(true);
  });

  it("局部异常正文保留有效片段并标记 incomplete", () => {
    const body = RawSubtitleBodySchema.parse(fixture("subtitle-body-partial.json"));
    const result = normalizeOfficialSubtitleBody(body, track, "cid-2");

    expect(result.transcript.segments.map((segment) => segment.text)).toEqual([
      "第一条有效字幕",
      "第二条有效字幕",
    ]);
    expect(result.transcript.complete).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  it("拒绝非 B站受信任域名，避免跟随外部地址请求", () => {
    expect(() => resolveSubtitleDownloadUrl("https://example.com/subtitle.json"))
      .toThrow(/不属于允许访问的平台域名/);
  });
});
