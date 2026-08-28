import { describe, expect, it } from "vitest";
import { BilibiliClient } from "../../scripts/bilibili/client.js";
import {
  getBilibiliSubtitle,
} from "../../scripts/subtitle/get.js";
import type { RunAsrTranscriptResult } from "../../scripts/subtitle/asr/runner.js";

/**
 * 真实网络测试默认跳过，避免普通开发与持续集成受 B站接口变化、风控影响。
 *
 * 手工开启：
 * RUN_BILIBILI_INTEGRATION=1 npm run test:integration
 *
 * 可通过 BILIBILI_COOKIE 传入本机登录态；测试不会打印 Cookie。
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";
const knownSubtitleVideo = process.env.BILIBILI_SUBTITLE_VIDEO ?? "BV1inX5YgELE";
const knownNoSubtitleVideo = process.env.BILIBILI_NO_SUBTITLE_VIDEO ?? "BV1774UzJErT";
const multiPartVideo = process.env.BILIBILI_MULTIPART_SUBTITLE_VIDEO;
const suite = enabled ? describe : describe.skip;

/**
 * 本文件只验证真实的 B站官方字幕链路。固定返回 ASR 不可用，避免测试结果受本机
 * 是否已安装 FunASR、模型是否已下载以及视频时长影响。
 */
async function unavailableAsr(): Promise<RunAsrTranscriptResult> {
  return {
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
      reasonCode: "asr_disabled_for_integration_test",
      message: "当前集成测试只验证官方字幕链路",
      warnings: [],
    },
  };
}

suite("bilibili.get_subtitle 真实集成测试", () => {
  it("能从已知有字幕的公开视频得到带时间戳 Transcript", async () => {
    const client = new BilibiliClient({ cookie: process.env.BILIBILI_COOKIE });
    // Tool 内部已对首次空轨做一次有限复核，集成测试不再从外层重复整次调用。
    const result = await getBilibiliSubtitle(
      { video: knownSubtitleVideo },
      { client, runAsr: unavailableAsr },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(["official", "official_ai"]).toContain(result.transcript?.source);
    expect(result.transcript?.segments.length).toBeGreaterThan(0);
    expect(result.transcript?.segments[0]?.startSeconds).toBeGreaterThanOrEqual(0);
    expect(["success", "partial"]).toContain(result.acquisition.status);
  }, 90_000);

  it("已知无字幕视频返回 missing，而不是程序失败", async () => {
    const client = new BilibiliClient({ cookie: process.env.BILIBILI_COOKIE });
    const result = await getBilibiliSubtitle(
      { video: knownNoSubtitleVideo },
      { client, runAsr: unavailableAsr },
    );

    expect(result.outcome).toBe("missing");
    expect(result.acquisition.status).toBe("missing");
    expect(result.fallback?.strategy).toBe("audio_to_asr");
  }, 45_000);

  const multiPartTest = multiPartVideo ? it : it.skip;
  multiPartTest("多P视频未指定 cid 时不默认选择第一P", async () => {
    const client = new BilibiliClient({ cookie: process.env.BILIBILI_COOKIE });
    const result = await getBilibiliSubtitle({ video: multiPartVideo! }, { client });

    expect(result.outcome).toBe("selection_required");
    expect(result.pageChoices?.length).toBeGreaterThan(1);
  }, 45_000);
});
