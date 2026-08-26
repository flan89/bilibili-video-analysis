import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { BilibiliSubtitleClient } from "../../scripts/bilibili/client.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";
import {
  RawSubtitleViewSchema,
  type RawSubtitleView,
} from "../../scripts/subtitle/bilibili-raw-schema.js";
import { getBilibiliSubtitle } from "../../scripts/subtitle/get.js";
import { runAsrTranscript } from "../../scripts/subtitle/asr/runner.js";
import { encodeSubtitleViewFixture } from "../helpers/subtitle-protobuf.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

interface SubtitleFixtureClientOptions {
  metadataFixture?: "view-single.json" | "view-multi.json";
  view?: RawSubtitleView;
  /** 按调用顺序返回字幕轨，用于模拟首次空轨、复核恢复。 */
  viewSequence?: RawSubtitleView[];
  body?: unknown;
  failure?: "metadata" | "view" | "body";
  /** 仅让第几次字幕轨请求失败，用于验证补充复核不会破坏首次可解释结果。 */
  failViewOnCall?: number;
  resolvedUrl?: string;
}

class SubtitleFixtureClient implements BilibiliSubtitleClient {
  readonly binaryQueries: Array<Record<string, string | number | boolean | undefined>> = [];
  readonly resolvedUrls: string[] = [];
  private readonly metadataFixture: "view-single.json" | "view-multi.json";
  private readonly view: RawSubtitleView;
  private readonly viewSequence?: RawSubtitleView[];
  private readonly body: unknown;
  private readonly failure?: "metadata" | "view" | "body";
  private readonly failViewOnCall?: number;
  private readonly resolvedUrl?: string;

  constructor(options: SubtitleFixtureClientOptions = {}) {
    this.metadataFixture = options.metadataFixture ?? "view-single.json";
    this.view = options.view ?? rawView("subtitle-view-single.json");
    this.viewSequence = options.viewSequence;
    this.body = options.body ?? fixture("subtitle-body.json");
    this.failure = options.failure;
    this.failViewOnCall = options.failViewOnCall;
    this.resolvedUrl = options.resolvedUrl;
  }

  async getApiData<T>(
    path: string,
    _query: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
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

  async getBinary(
    _path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<Uint8Array> {
    this.binaryQueries.push(query);
    if (
      this.failure === "view"
      || this.binaryQueries.length === this.failViewOnCall
    ) {
      throw new BilibiliError({
        code: "subtitle_view_failed",
        message: "模拟字幕轨接口失败",
        retryable: true,
      });
    }
    const sequenceIndex = Math.min(
      this.binaryQueries.length - 1,
      Math.max(0, (this.viewSequence?.length ?? 1) - 1),
    );
    return encodeSubtitleViewFixture(this.viewSequence?.[sequenceIndex] ?? this.view);
  }

  async getJsonFromUrl<T>(_url: string, schema: z.ZodType<T>): Promise<T> {
    if (this.failure === "body") {
      throw new BilibiliError({
        code: "subtitle_body_failed",
        message: "模拟字幕正文接口失败",
        retryable: true,
      });
    }
    return schema.parse(this.body);
  }
}

function rawView(name: string): RawSubtitleView {
  return RawSubtitleViewSchema.parse(fixture(name));
}

describe("getBilibiliSubtitle", () => {
  beforeEach(() => {
    // 每个测试前 reset ASR mock, 避免上一次测试的 mockResolved / mockRejected 状态污染
    vi.mocked(runAsrTranscript).mockReset();
  });

  it("自行获取必要元信息并返回独立字幕结果", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient() },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.video).toEqual({ bvid: "BV15wGR6CEhY", cid: "3001002001" });
    expect(result.transcript?.source).toBe("official");
    expect(result.transcript?.segments).toHaveLength(3);
    expect(result.processing?.stats).toMatchObject({
      inputSegmentCount: 3,
      outputSegmentCount: 3,
    });
    expect(result.acquisition.status).toBe("success");
    expect(result).not.toHaveProperty("asset");
  });

  it("多语言轨按 language 选择，并正确标记 AI 字幕", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY", language: "ai-zh" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-multi.json") }) },
    );

    expect(result.success).toBe(true);
    expect(result.availableTracks).toHaveLength(2);
    expect(result.transcript).toMatchObject({ source: "official_ai", language: "zh" });
  });

  it("目标语言不存在时返回 missing，并保留可用轨道摘要", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY", language: "ja-JP" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-multi.json") }) },
    );

    expect(result.outcome).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("subtitle_language_not_found");
    expect(result.availableTracks).toHaveLength(2);
    expect(result.transcript).toBeUndefined();
  });

  it("没有官方字幕时返回 missing 和自动语音识别后续建议", async () => {
    const client = new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") });
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client },
    );

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("no_official_subtitle");
    expect(result.fallback?.strategy).toBe("audio_to_asr");
    expect(result.transcript).toBeUndefined();
    expect(client.binaryQueries).toHaveLength(2);
    expect(result.acquisition.warnings.join("\n")).toContain("连续两次返回空结果");
  });

  it("字幕轨首次空响应时只复核一次，并使用恢复后的官方字幕", async () => {
    const client = new SubtitleFixtureClient({
      viewSequence: [
        rawView("subtitle-view-none.json"),
        rawView("subtitle-view-single.json"),
      ],
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.transcript?.source).toBe("official");
    expect(client.binaryQueries).toHaveLength(2);
    expect(result.acquisition.warnings.join("\n")).toContain("有限复核后恢复");
  });

  it("首次空轨后的补充复核失败时保留不确定性并继续降级", async () => {
    const client = new SubtitleFixtureClient({
      view: rawView("subtitle-view-none.json"),
      failViewOnCall: 2,
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client },
    );

    expect(result.outcome).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("no_official_subtitle");
    expect(client.binaryQueries).toHaveLength(2);
    expect(result.acquisition.warnings.join("\n")).toContain("有限复核失败");
    expect(result.acquisition.warnings.join("\n")).toContain("无法确认");
  });

  it("字幕正文为空时返回 missing，不把它当程序异常", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ body: fixture("subtitle-body-empty.json") }) },
    );

    expect(result.outcome).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("empty_subtitle_body");
  });

  it("元信息接口失败时返回字幕 Tool 的结构化 failed", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ failure: "metadata" }) },
    );

    expect(result.outcome).toBe("failed");
    expect(result.acquisition.source).toBe("bilibili_web_api");
    expect(result.error).toMatchObject({ code: "metadata_failed", retryable: true });
  });

  it("字幕轨接口失败时返回结构化 failed", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ failure: "view" }) },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatchObject({ code: "subtitle_view_failed", retryable: true });
  });

  it("字幕正文接口失败时返回结构化 failed", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ failure: "body" }) },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("subtitle_body_failed");
  });

  it("多P没有 cid 时要求 Agent 选择，不偷偷使用第一P", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle({ video: "av999000111" }, { client });

    expect(result.outcome).toBe("selection_required");
    expect(result.pageChoices?.map((page) => page.cid)).toEqual(["81001", "81002"]);
    expect(result.acquisition.status).toBe("not_requested");
    expect(client.binaryQueries).toHaveLength(0);
  });

  it("多P显式 cid 只请求目标分P", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      { video: "av999000111", cid: "81002" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    expect(result.transcript?.cid).toBe("81002");
    expect(client.binaryQueries[0]?.oid).toBe("81002");
  });

  it("多P URL 的 p 参数直接选择对应分P", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      { video: "https://www.bilibili.com/video/av999000111?p=2" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    expect(client.binaryQueries[0]?.oid).toBe("81002");
  });

  it("多P可用自然分P编号选择，不要求 Agent 提供 cid", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      { video: "av999000111", page: 2 },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    expect(client.binaryQueries[0]?.oid).toBe("81002");
  });

  it("分P编号不存在时结构化失败，不回退到第一P", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      { video: "av999000111", page: 3 },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatchObject({ code: "unknown_page", retryable: false });
    expect(client.binaryQueries).toHaveLength(0);
  });

  it("命令分P与 URL 分P冲突时结构化失败", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      {
        video: "https://www.bilibili.com/video/av999000111?p=1",
        page: 2,
      },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("conflicting_page_selection");
    expect(client.binaryQueries).toHaveLength(0);
  });

  it("cid 与自然分P编号冲突时结构化失败", async () => {
    const client = new SubtitleFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliSubtitle(
      { video: "av999000111", page: 1, cid: "81002" },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("conflicting_page_selection");
    expect(client.binaryQueries).toHaveLength(0);
  });

  it("短链展开后的 p 参数选择分P，且短链只解析一次", async () => {
    const client = new SubtitleFixtureClient({
      metadataFixture: "view-multi.json",
      resolvedUrl: "https://www.bilibili.com/video/av999000111?p=2",
    });
    const result = await getBilibiliSubtitle(
      { video: "https://b23.tv/multipart" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    expect(client.resolvedUrls).toEqual(["https://b23.tv/multipart"]);
    expect(client.binaryQueries[0]?.oid).toBe("81002");
  });

  it("部分异常片段返回可用 Transcript，并把来源状态标成 partial", async () => {
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ body: fixture("subtitle-body-partial.json") }) },
    );

    expect(result.success).toBe(true);
    expect(result.acquisition.status).toBe("partial");
    expect(result.transcript?.complete).toBe(false);
    expect(result.transcript?.segments).toHaveLength(2);
  });

  it("Level 1 partial 时不调 ASR, 不会被 ASR 失败污染 (保护不变量)", async () => {
    // mock ASR 抛错: 如果 Tool 在 partial 路径上错误调了 ASR, 这里会触发
    vi.mocked(runAsrTranscript).mockRejectedValue(new Error("如果调到这里说明触发条件错了"));

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ body: fixture("subtitle-body-partial.json") }) },
    );

    // 关键断言: partial 状态保持, 没有任何 ASR 相关 warning
    expect(result.acquisition.status).toBe("partial");
    expect(result.transcript?.source).not.toBe("asr");
    expect(result.acquisition.warnings.some((w) => w.includes("asr_"))).toBe(false);
    // ASR 完全没被调用
    expect(vi.mocked(runAsrTranscript)).not.toHaveBeenCalled();
  });

  it("确定性清理规范空白并合并相邻完全重复字幕，同时保留来源 ID", async () => {
    const duplicateBody = {
      body: [
        { from: 1, to: 2, content: "  保留   原意  " },
        { from: 2.2, to: 3, content: "保留 原意" },
      ],
    };
    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ body: duplicateBody }) },
    );

    expect(result.transcript?.segments).toHaveLength(1);
    expect(result.transcript?.segments[0]?.text).toBe("保留 原意");
    expect(result.transcript?.segments[0]?.metadata?.sourceSegmentIds).toHaveLength(2);
    expect(result.processing?.stats.duplicateSegmentCount).toBe(1);
  });
});

/**
 * D14 fallback 集成测试:
 * 官方字幕缺失 → getBilibiliSubtitle 应自动调 Level 3 ASR.
 * 这里 mock 掉 asr/runner.ts, 避免依赖 Python / 网络 / 模型文件.
 */
vi.mock("../../scripts/subtitle/asr/runner.js", () => ({
  runAsrTranscript: vi.fn(),
}));

describe("getBilibiliSubtitle ASR fallback (D14)", () => {
  beforeEach(() => {
    vi.mocked(runAsrTranscript).mockReset();
  });

  it("Level 1 缺失 + ASR 成功 → outcome=success, source=asr, acquisition.source=funasr", async () => {
    vi.mocked(runAsrTranscript).mockResolvedValue({
      transcript: {
        source: "asr",
        language: "zh-CN",
        cid: "3001002001",
        segments: [
          { id: "asr-1", startSeconds: 0, endSeconds: 2, text: "ASR 转写" },
        ],
        complete: true,
      },
      acquisition: {
        dataKind: "transcript",
        status: "success",
        source: "funasr",
        itemCount: 1,
        warnings: [],
      },
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") }) },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.transcript?.source).toBe("asr");
    expect(result.transcript?.segments).toHaveLength(1);
    expect(result.acquisition.source).toBe("funasr");
    expect(result.acquisition.status).toBe("success");
    expect(result.processing?.method).toBe("asr_fallback");
    expect(result.processing?.stats.inputSegmentCount).toBe(1);
  });

  it("Level 1 缺失 + ASR 失败 → 保留 missing, warnings 追加 asr_unavailable", async () => {
    vi.mocked(runAsrTranscript).mockResolvedValue({
      transcript: {
        source: "asr",
        language: "zh-CN",
        segments: [],
        complete: false,
      },
      acquisition: {
        dataKind: "transcript",
        status: "failed",
        source: "funasr",
        reasonCode: "asr_pipeline_exception",
        message: "ASR 流水线异常: 测试模拟",
        warnings: [],
      },
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") }) },
    );

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("no_official_subtitle");
    expect(result.acquisition.warnings.some((w) => w.startsWith("asr_unavailable:"))).toBe(true);
    expect(result.fallback?.strategy).toBe("audio_to_asr");
    expect(result.transcript).toBeUndefined();
  });

  it("Level 1 缺失 + ASR 部分成功 → 保留可用字幕和部分完成状态", async () => {
    vi.mocked(runAsrTranscript).mockResolvedValue({
      transcript: {
        source: "asr",
        language: "zh-CN",
        cid: "3001002001",
        segments: [
          { id: "asr-0", startSeconds: 0, endSeconds: 2, text: "部分识别结果" },
        ],
        complete: false,
      },
      acquisition: {
        dataKind: "transcript",
        status: "partial",
        source: "funasr",
        itemCount: 1,
        warnings: ["asr_vad_filtered_short_segments: 过滤了少量过短片段"],
      },
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") }) },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.warnings).toContain(
      "asr_vad_filtered_short_segments: 过滤了少量过短片段",
    );
    expect(result.transcript?.segments).toHaveLength(1);
  });

  it("ASR 运行环境缺失 → 返回可执行的 doctor / plan / apply 提示", async () => {
    vi.mocked(runAsrTranscript).mockResolvedValue({
      transcript: { source: "asr", language: "zh-CN", segments: [], complete: false },
      acquisition: {
        dataKind: "transcript",
        status: "failed",
        source: "funasr",
        reasonCode: "asr_runtime_unavailable",
        message: "ASR 环境未准备",
        warnings: [],
      },
    });

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") }) },
    );

    expect(result.setupHint?.capability).toBe("asr");
    expect(result.setupHint?.doctorCommand.args).toContain("doctor");
    expect(result.setupHint?.planCommand.args).toContain("--plan");
    expect(result.setupHint?.applyCommand.args).toContain("--apply");
    expect(result.setupHint?.applyCommand.args[0]).toMatch(/dist\/cli\.mjs$/);
  });

  it("Level 1 缺失 + ASR runner 抛异常 → 保留 missing, warnings 追加 asr_runner_exception", async () => {
    vi.mocked(runAsrTranscript).mockRejectedValue(new Error("编程错误: schema 错"));

    const result = await getBilibiliSubtitle(
      { video: "BV15wGR6CEhY" },
      { client: new SubtitleFixtureClient({ view: rawView("subtitle-view-none.json") }) },
    );

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("missing");
    expect(result.acquisition.warnings.some((w) => w.startsWith("asr_runner_exception:"))).toBe(true);
    expect(result.fallback?.strategy).toBe("audio_to_asr");
  });
});
