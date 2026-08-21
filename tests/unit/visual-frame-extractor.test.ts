/**
 * tests/unit/visual-frame-extractor.test.ts: frame-extractor / scene-detector / media-probe 单元测试.
 *
 * 覆盖:
 * - makeVideoKey 稳定 + 不同 bvid 产出不同 key
 * - cleanupVideoTemp 真删目录
 * - cleanupExpiredTemp 跳过未过期, 清理过期
 * - extractTimestamps 找不到 ffmpeg → FFmpegUnavailableError
 * - detectVisualChanges 找不到 ffmpeg → reject
 *
 * 真实 ffmpeg 提帧 + scene 检测留给 E2E (m5.1 端到端跑 BV1xx411c7mD).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupExpiredTemp,
  cleanupVideoTemp,
  extractTimestamps,
  FFmpegUnavailableError,
  makeVideoKey,
  TEMP_FILE_TTL_MS,
} from "../../scripts/visual/frame-extractor.js";
import { detectVisualChanges } from "../../scripts/visual/scene-detector.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "visual-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("makeVideoKey", () => {
  it("稳定, 同参数产出同 key", () => {
    const a = makeVideoKey({ bvid: "BV1xx", cid: "12345", quality: 80, resolution: "720p" });
    const b = makeVideoKey({ bvid: "BV1xx", cid: "12345", quality: 80, resolution: "720p" });
    expect(a).toBe(b);
  });

  it("不同 bvid 产出不同 key", () => {
    const a = makeVideoKey({ bvid: "BV1xx", cid: "12345", quality: 80, resolution: "720p" });
    const b = makeVideoKey({ bvid: "BV1yy", cid: "12345", quality: 80, resolution: "720p" });
    expect(a).not.toBe(b);
  });

  it("不同 resolution 产出不同 key", () => {
    const a = makeVideoKey({ bvid: "BV1xx", cid: "12345", quality: 80, resolution: "720p" });
    const b = makeVideoKey({ bvid: "BV1xx", cid: "12345", quality: 80, resolution: "1080p" });
    expect(a).not.toBe(b);
  });
});

describe("cleanupVideoTemp", () => {
  it("best-effort 删除视频目录 (包括不存在场景)", async () => {
    // 不存在
    await cleanupVideoTemp("nonexistent-key", scratch);
    // 真实存在
    const dir = join(scratch, "key123");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "test.jpg"), "fake");
    await cleanupVideoTemp("key123", scratch);
    await expect(stat(dir)).rejects.toThrow();
  });
});

describe("cleanupExpiredTemp", () => {
  it("清理超过 TTL 的目录, 跳过新的", async () => {
    // 旧目录 (1 小时前 mtime)
    const oldDir = join(scratch, "old-key");
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "old.jpg"), "fake");
    const pastMtime = Date.now() - TEMP_FILE_TTL_MS - 60_000;
    // 重设 mtime (await utimes via fs.utimes, 但用 raw system call)
    const { utimes } = await import("node:fs/promises");
    await utimes(oldDir, pastMtime / 1000, pastMtime / 1000);

    // 新目录
    const newDir = join(scratch, "new-key");
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "new.jpg"), "fake");

    const result = await cleanupExpiredTemp(scratch, TEMP_FILE_TTL_MS);
    expect(result.cleaned).toBeGreaterThanOrEqual(1);

    // 旧目录被删
    await expect(stat(oldDir)).rejects.toThrow();
    // 新目录保留
    const newStat = await stat(newDir);
    expect(newStat.isDirectory()).toBe(true);
  });

  it("根目录不存在 → 返回 cleaned=0, 不抛", async () => {
    const emptyScratch = join(scratch, "nonexistent");
    const result = await cleanupExpiredTemp(emptyScratch, TEMP_FILE_TTL_MS);
    expect(result.cleaned).toBe(0);
  });
});

describe("extractTimestamps ffmpeg 不可用", () => {
  it("ffmpeg 不在 PATH → FFmpegUnavailableError", async () => {
    // 用一个肯定不存在的 ffmpeg 路径
    await expect(
      extractTimestamps({
        sourcePath: "/tmp/fake.mp4",
        videoKey: "test-key",
        timestamps: [1, 30, 60],
        options: { ffmpegPath: "/nonexistent/ffmpeg-binary-xyz", tempDir: scratch },
      }),
    ).rejects.toBeInstanceOf(FFmpegUnavailableError);
  });
});

describe("detectVisualChanges ffmpeg 不可用", () => {
  it("ffmpeg 不在 PATH → reject", async () => {
    await expect(
      detectVisualChanges("/tmp/fake.mp4", { ffmpegPath: "/nonexistent/ffmpeg-binary-xyz" }),
    ).rejects.toThrow();
  });
});
