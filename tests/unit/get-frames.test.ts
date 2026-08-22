/**
 * tests/unit/get-frames.test.ts: `bilibili.get_frames` Tool 端到端测试.
 *
 * 覆盖:
 * - timestamp / interval / scene 三种 mode 成功
 * - 多P 未选 → selection_required
 * - 多P 显式 page / cid 选择
 * - cid / page / URL p 冲突
 * - 未知 page / cid → 结构化失败
 * - metadata 接口失败 → frames Tool 失败
 * - playurl 失败 → playurl_prerequisite_failed
 * - DASH 完整媒体下载与时长不足处理
 * - frame_extraction 失败 → frame_extraction_failed
 * - ffmpeg 不可用 → ffmpeg_unavailable
 *
 * mock 思路:
 *   1) FixtureClient → 提供 metadata (用 view-single.json / view-multi.json)
 *   2) Mock playurl / extractTimestamps / extractInterval / extractScene
 *   3) 控制 fetch 行为 (失败 / 成功) 模拟下载
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BilibiliSubtitleClient } from "../../scripts/bilibili/client.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";
import { resolvePlayUrl } from "../../scripts/bilibili/playurl.js";
import {
  extractInterval,
  extractScene,
  extractTimestamps,
  FFmpegUnavailableError,
  FrameExtractionError,
  makeVideoKey,
} from "../../scripts/visual/frame-extractor.js";
import { detectVisualChanges } from "../../scripts/visual/scene-detector.js";
import { probeMedia } from "../../scripts/visual/media-probe.js";
import { getBilibiliFrames } from "../../scripts/visual/get.js";
import { FrameSchema } from "../../scripts/models/frame.js";

vi.mock("../../scripts/bilibili/playurl.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/bilibili/playurl.js")>(
    "../../scripts/bilibili/playurl.js",
  );
  return {
    ...actual,
    resolvePlayUrl: vi.fn(),
  };
});

vi.mock("../../scripts/visual/frame-extractor.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/visual/frame-extractor.js")>(
    "../../scripts/visual/frame-extractor.js",
  );
  return {
    ...actual,
    extractTimestamps: vi.fn(),
    extractInterval: vi.fn(),
    extractScene: vi.fn(),
    cleanupVideoTemp: vi.fn().mockResolvedValue(undefined),
    cleanupExpiredTemp: vi.fn().mockResolvedValue({ cleaned: 0 }),
  };
});

vi.mock("../../scripts/visual/scene-detector.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/visual/scene-detector.js")>(
    "../../scripts/visual/scene-detector.js",
  );
  return {
    ...actual,
    detectVisualChanges: vi.fn(),
  };
});

vi.mock("../../scripts/visual/media-probe.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/visual/media-probe.js")>(
    "../../scripts/visual/media-probe.js",
  );
  return {
    ...actual,
    probeMedia: vi.fn(),
  };
});


function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

interface FramesFixtureClientOptions {
  metadataFixture?: "view-single.json" | "view-multi.json";
  failure?: "metadata";
  resolvedUrl?: string;
}

class FramesFixtureClient implements BilibiliSubtitleClient {
  readonly resolvedUrls: string[] = [];
  private readonly metadataFixture: "view-single.json" | "view-multi.json";
  private readonly failure?: "metadata";
  private readonly resolvedUrl?: string;

  constructor(options: FramesFixtureClientOptions = {}) {
    this.metadataFixture = options.metadataFixture ?? "view-single.json";
    this.failure = options.failure;
    this.resolvedUrl = options.resolvedUrl;
  }

  async getApiData<T>(
    path: string,
    _query: Record<string, string | number | boolean | undefined>,
    schema: { parse: (input: unknown) => T },
  ): Promise<T> {
    if (!path.includes("/view")) {
      throw new Error(`未知 fixture path: ${path}`);
    }
    if (this.failure === "metadata") {
      throw new BilibiliError({
        code: "metadata_failed",
        message: "模拟元信息接口失败",
        retryable: true,
      });
    }
    return schema.parse(fixture(this.metadataFixture));
  }

  async resolveFinalUrl(url: string): Promise<string> {
    this.resolvedUrls.push(url);
    return this.resolvedUrl ?? url;
  }

  async getBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async getJsonFromUrl<T>(_url: string, schema: { parse: (input: unknown) => T }): Promise<T> {
    return schema.parse({});
  }
}

function makeMockFrame(videoKey: string, t: number): ReturnType<typeof FrameSchema.parse> {
  return FrameSchema.parse({
    id: `F-${videoKey}-${t.toString().padStart(6, "0")}`,
    cid: videoKey.split("-")[1] ?? "",
    timestampSeconds: t,
    uri: `file:///tmp/${videoKey}/${t}.jpg`,
    reason: "timestamp",
    reasonDetail: "mock",
    metadata: { filePath: `/tmp/${videoKey}/${t}.jpg` },
  });
}

function mockStreamDurl(overrides: Partial<{
  quality: number;
  acceptQuality: number[];
  durationSeconds: number;
}> = {}) {
  return {
    quality: overrides.quality ?? 80,
    durationSeconds: overrides.durationSeconds ?? 2055,
    videoBaseUrl: "https://example.com/durl-fallback.mp4",
    videoInit: "",
    videoMimeType: "video/mp4",
    videoCodecs: "avc1.64001F",
    videoWidth: 1920,
    videoHeight: 1080,
    acceptQuality: overrides.acceptQuality ?? [80, 64, 16],
    durlUrls: ["https://example.com/source.mp4"],
  };
}

function mockStreamDashOnly() {
  return {
    quality: 80,
    durationSeconds: 2055,
    videoBaseUrl: "https://example.com/init.m4s",
    videoInit: "AAAA",
    videoMimeType: "video/mp4",
    videoCodecs: "avc1.64001F",
    videoWidth: 1920,
    videoHeight: 1080,
    acceptQuality: [80, 64, 32, 16],
    // durlUrls 缺失时走 DASH 完整媒体地址。
  };
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "get-frames-test-"));
  vi.mocked(resolvePlayUrl).mockReset();
  vi.mocked(extractTimestamps).mockReset();
  vi.mocked(extractInterval).mockReset();
  vi.mocked(extractScene).mockReset();
  vi.mocked(detectVisualChanges).mockReset();
  vi.mocked(probeMedia).mockReset();
  // 默认 probe 成功
  vi.mocked(probeMedia).mockResolvedValue({
    durationSeconds: 2055,
    video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
    audio: undefined,
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("getBilibiliFrames — timestamp mode", () => {
  it("单P 视频 timestamp 模式 拿 3 帧", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractTimestamps).mockResolvedValue([
      makeMockFrame(videoKey, 1),
      makeMockFrame(videoKey, 30),
      makeMockFrame(videoKey, 60),
    ]);

    const fetchImpl = vi.fn(async (url: string) => {
      // 模拟下载 durl 单文件
      return new Response(Buffer.from("fake-mp4-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      {
        video: "BV15wGR6CEhY",
        mode: "timestamp",
        timestamps: [1, 30, 60],
      },
      {
        client: new FramesFixtureClient(),
        fetchImpl,
        tempDir: scratch,
        skipTempCleanup: true,
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.frameset?.frames).toHaveLength(3);
    expect(result.frameset?.mode).toBe("timestamp");
    expect(result.frameset?.coverage.frameCount).toBe(3);
    expect(result.frameset?.coverage.targetDurationSeconds).toBe(2055);
  });

  it("timestamps 超过视频时长 → warning + complete=false", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl({ durationSeconds: 100 }));
    vi.mocked(extractTimestamps).mockResolvedValue([
      makeMockFrame(videoKey, 1),
    ]);
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      {
        video: "BV15wGR6CEhY",
        mode: "timestamp",
        timestamps: [1, 5000, 9999], // 5000/9999 都超 100s
      },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.coverage.complete).toBe(false);
    expect(result.frameset?.warnings.length).toBeGreaterThan(0);
    expect(result.frameset?.warnings[0]).toMatch(/超过视频时长/);
  });
});

describe("getBilibiliFrames — interval mode", () => {
  it("单P 视频 interval 模式", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractInterval).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => makeMockFrame(videoKey, i * 60)),
    );
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV15wGR6CEhY", mode: "interval", intervalSeconds: 60, maxFrames: 10 },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.frames).toHaveLength(5);
    expect(result.frameset?.mode).toBe("interval");
  });

  it("interval maxFrames 截断 → complete=false + acquisition=partial + warning", async () => {
    // 视频 2055s / interval 30s = plan 69 帧, maxFrames=5 截断
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractInterval).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => makeMockFrame(videoKey, i * 30)),
    );
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV15wGR6CEhY", mode: "interval", intervalSeconds: 30, maxFrames: 5 },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.frames).toHaveLength(5);
    expect(result.frameset?.coverage.complete).toBe(false);
    expect(result.frameset?.coverage.truncated).toBe(true);
    expect(result.frameset?.coverage.plannedFrameCount).toBe(69); // ceil(2055/30) = 69
    expect(result.frameset?.coverage.requestedFrameCount).toBe(5);
    expect(result.frameset?.warnings[0]).toMatch(/maxFrames=5 截断/);
    expect(result.frameset?.acquisition.status).toBe("partial");
  });
});

describe("getBilibiliFrames — timestamp sort + dedupe + 毫秒文件", () => {
  it("重复 timestamp + out-of-order 输入 → sort + dedupe 生效", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    const extractedArgs: { timestamps: number[] } = { timestamps: [] };
    vi.mocked(extractTimestamps).mockImplementation(async (args) => {
      extractedArgs.timestamps = args.timestamps;
      return args.timestamps.map((t) => makeMockFrame(videoKey, t));
    });
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      {
        video: "BV15wGR6CEhY",
        mode: "timestamp",
        // 输入故意: 重复 30, 倒序, 含 1
        timestamps: [30, 1, 30, 60, 1],
      },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    // 抽帧前 sort + dedupe
    expect(extractedArgs.timestamps).toEqual([1, 30, 60]);
    expect(result.frameset?.frames).toHaveLength(3);
    // frames 按 timestamp 升序
    expect(result.frameset?.frames[0]?.timestampSeconds).toBe(1);
    expect(result.frameset?.frames[1]?.timestampSeconds).toBe(30);
    expect(result.frameset?.frames[2]?.timestampSeconds).toBe(60);
  });
});

describe("getBilibiliFrames — scene mode", () => {
  it("scene mode 走 detectVisualChanges → extractScene", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(detectVisualChanges).mockResolvedValue({
      candidates: [
        { timestampSeconds: 10 },
        { timestampSeconds: 30 },
        { timestampSeconds: 50 },
      ],
      totalDetected: 3,
      truncated: false,
    });
    vi.mocked(extractScene).mockResolvedValue([
      makeMockFrame(videoKey, 10),
      makeMockFrame(videoKey, 30),
      makeMockFrame(videoKey, 50),
    ]);
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV15wGR6CEhY", mode: "scene", sceneThreshold: 0.4, maxFrames: 10 },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.frames).toHaveLength(3);
    expect(detectVisualChanges).toHaveBeenCalledOnce();
    expect(extractScene).toHaveBeenCalledOnce();
  });

  it("scene mode 0 候选 → success (扫完整), warning 但不报错 ()", async () => {
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(detectVisualChanges).mockResolvedValue({
      candidates: [],
      totalDetected: 0,
      truncated: false,
    });
    vi.mocked(extractScene).mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV15wGR6CEhY", mode: "scene", sceneThreshold: 0.4, maxFrames: 10 },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    // 0 候选 = success (扫完整), 不算采集失败
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.frameset?.frames).toHaveLength(0);
    expect(result.frameset?.visualChanges).toEqual([]);
    // complete 仍 true (没截断, 没失败, 就是没候选)
    expect(result.frameset?.coverage.complete).toBe(true);
    expect(result.frameset?.warnings[0]).toMatch(/没有找到任何通过阈值/);
    // acquisition status 仍是 success
    expect(result.frameset?.acquisition.status).toBe("success");
  });
});

describe("getBilibiliFrames — 多P 选分P", () => {
  it("多P 未选 → selection_required", async () => {
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "interval", intervalSeconds: 60 },
      { client: new FramesFixtureClient({ metadataFixture: "view-multi.json" }), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("selection_required");
    expect(result.pageChoices).toBeDefined();
    expect(result.pageChoices!.length).toBeGreaterThan(1);
  });

  it("多P 显式 cid 选成功", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV1xx411c7mD", cid: String((fixture("view-multi.json") as { pages: Array<{ cid: number }> }).pages[1]!.cid),
      quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractInterval).mockResolvedValue([
      makeMockFrame(videoKey, 1),
      makeMockFrame(videoKey, 61),
    ]);
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;

    const multi = fixture("view-multi.json") as { pages: Array<{ cid: number }> };
    const secondCid = String(multi.pages[1]!.cid);

    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "interval", intervalSeconds: 60, cid: secondCid },
      { client: new FramesFixtureClient({ metadataFixture: "view-multi.json" }), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.video.cid).toBe(secondCid);
  });

  it("cid 不在分P 列表 → unknown_cid failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "interval", intervalSeconds: 60, cid: "9999999999" },
      { client: new FramesFixtureClient({ metadataFixture: "view-multi.json" }), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.reasonCode).toBe("unknown_cid");
  });

  it("page 越界 → unknown_page failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "interval", intervalSeconds: 60, page: 99 },
      { client: new FramesFixtureClient({ metadataFixture: "view-multi.json" }), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("unknown_page");
  });
});

describe("getBilibiliFrames — 错误路径", () => {
  it("metadata 失败 → metadata_prerequisite_failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient({ failure: "metadata" }), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("metadata_failed");
  });

  it("playurl 失败 → playurl_prerequisite_failed", async () => {
    vi.mocked(resolvePlayUrl).mockRejectedValue(
      new BilibiliError({ code: "playurl_http_error", message: "playurl HTTP 403", retryable: false }),
    );
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("playurl_prerequisite_failed");
  });

  it("downloads the complete DASH media URL without rebuilding SegmentBase", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDashOnly());
    vi.mocked(extractTimestamps).mockResolvedValue([makeMockFrame(videoKey, 1)]);
    const fetchImpl = vi.fn(async () => new Response("complete-m4s", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.metadata?.streamInfo).toMatchObject({ quality: 80 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("marks DASH duration shortage as partial and incomplete", async () => {
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 80, resolution: "720p",
    });
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDashOnly());
    vi.mocked(probeMedia).mockResolvedValue({
      durationSeconds: 100,
      video: { codec: "h264", width: 1280, height: 720, fps: 30 },
      audio: undefined,
    });
    vi.mocked(extractTimestamps).mockResolvedValue([makeMockFrame(videoKey, 1)]);
    const fetchImpl = vi.fn(async () => new Response("partial-m4s", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.acquisition.status).toBe("partial");
    expect(result.frameset?.coverage.complete).toBe(false);
    expect(result.frameset?.coverage.targetDurationSeconds).toBe(2020);
    expect(result.frameset?.coverage.mediaDurationShortageRatio).toBeCloseTo(100 / 2020);
  });

  it("reports requested quality downgrade as partial", async () => {
    const stream = mockStreamDurl({ quality: 64 });
    stream.acceptQuality = [64, 32, 16];
    vi.mocked(resolvePlayUrl).mockResolvedValue(stream);
    const videoKey = makeVideoKey({
      bvid: "BV15wGR6CEhY", cid: "3001002001", quality: 64, resolution: "1080p",
    });
    vi.mocked(extractTimestamps).mockResolvedValue([makeMockFrame(videoKey, 1)]);
    const fetchImpl = vi.fn(async () => new Response("video", { status: 200 })) as unknown as typeof fetch;

    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1], resolution: "1080p" },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(true);
    expect(result.frameset?.acquisition.status).toBe("partial");
    expect(result.frameset?.warnings.join("\n")).toContain("清晰度代码 80");
    expect(result.frameset?.warnings.join("\n")).toContain("实际返回代码 64");
  });


  it("frame extraction 抛 FrameExtractionError → frame_extraction_failed", async () => {
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractTimestamps).mockRejectedValue(
      new FrameExtractionError("ffmpeg 提帧失败", "stderr...", 1),
    );
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("frame_extraction_failed");
  });

  it("ffmpeg 不可用 → ffmpeg_unavailable", async () => {
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractTimestamps).mockRejectedValue(
      new FFmpegUnavailableError("ffmpeg 不可用"),
    );
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("ffmpeg_unavailable");
    expect(result.setupHint?.capability).toBe("media");
    expect(result.setupHint?.planCommand.args).toContain("--plan");
    expect(result.setupHint?.applyCommand.args).toContain("--apply");
    expect(result.setupHint?.applyCommand.args[0]).toMatch(/dist\/cli\.mjs$/);
  });

  it("下载视频流 HTTP 404 → playurl_prerequisite_failed (retryable=false)", async () => {
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("playurl_prerequisite_failed");
    expect(result.message).toMatch(/下载视频源/);
  });

  it("fail() 返回 acquisition (status=failed) + video (有 bvid)", async () => {
    // 触发 metadata 失败时, 应有 video + acquisition 完整结构
    vi.mocked(resolvePlayUrl).mockResolvedValue(mockStreamDurl());
    vi.mocked(extractTimestamps).mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    // 走完整链路, video 应该有 bvid + cid
    // (此处 metadata 成功, playurl 成功, download 失败 → fail() 应有 bvid + cid)
    expect(result.success).toBe(false);
    expect(result.video).toEqual({ bvid: "BV15wGR6CEhY", cid: "3001002001" });
    expect(result.reasonCode).toBe("playurl_prerequisite_failed");
  });

  it("durl 多 fragment 拒绝", async () => {
    // 模拟老视频 FLV 多 durl
    vi.mocked(resolvePlayUrl).mockResolvedValue({
      quality: 80,
      durationSeconds: 1437,
      videoBaseUrl: "",
      videoInit: "",
      videoMimeType: "video/mp4",
      videoCodecs: "avc1.64001F",
      acceptQuality: [80, 64, 16],
      durlUrls: [
        "https://example.com/part1.flv",
        "https://example.com/part2.flv",
        "https://example.com/part3.flv",
      ],
    });
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    const result = await getBilibiliFrames(
      { video: "BV1xx411c7mD", mode: "timestamp", timestamps: [1] },
      { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
    );

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe("playurl_prerequisite_failed");
    expect(result.message).toMatch(/durl 多 fragment/);
  });
});

describe("getBilibiliFrames — Input validation", () => {
  it("mode=timestamp 缺 timestamps → 抛 Zod 错 (Tool 入口 Zod parse 必报)", async () => {
    const fetchImpl = vi.fn(async () => new Response("fake", { status: 200 })) as unknown as typeof fetch;
    await expect(
      getBilibiliFrames(
        { video: "BV1xx411c7mD", mode: "timestamp" } as any,
        { client: new FramesFixtureClient(), fetchImpl, tempDir: scratch, skipTempCleanup: true },
      ),
    ).rejects.toThrow(/timestamps/);
  });
});
