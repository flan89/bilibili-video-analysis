import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { BilibiliApiClient } from "../../scripts/bilibili/client.js";
import { resolvePlayUrl } from "../../scripts/bilibili/playurl.js";
import type { WbiSigner } from "../../scripts/bilibili/wbi.js";


function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("resolvePlayUrl DASH", () => {
  it("accepts the real Bilibili SegmentBase casing and byte ranges", async () => {
    const raw = fixture("playurl-dash.json");
    const fetchImpl = vi.fn(async () => Response.json(raw)) as unknown as typeof fetch;
    const signer = {
      signRequest: vi.fn().mockResolvedValue("avid=2&cid=62131&w_rid=test&wts=1"),
    } as unknown as WbiSigner;
    const client = { baseUrl: "https://api.bilibili.com/" } as unknown as BilibiliApiClient;

    const result = await resolvePlayUrl(client, {
      aid: 2,
      cid: 62131,
      quality: 64,
      dash: true,
      fetchImpl,
    }, signer);

    expect(result.videoBaseUrl).toBe("https://example.com/video.m4s");
    expect(result.videoInit).toBe("0-1021");
    expect(result.videoSegmentIndexRange).toBe("1022-5985");
    expect(result.audioInit).toBe("0-932");
  });
});
