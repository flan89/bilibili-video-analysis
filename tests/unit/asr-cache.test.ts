/**
 * asr/cache.ts 单元测试 :
 * - 路径解析 (transcriptCachePath) 必含 cid
 * - 读写 (writeTranscriptCache → readTranscriptCache 完整链路) 走 cid 隔离
 * - 不存在 / 非法 JSON / schema 验证失败都返回 null (不抛错)
 * - 自动创建目录
 * - 空 bvid / 空 cid 抛错
 * - cid 一致性契约: cache key 跟 transcript.cid 必须一致 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcquisitionRecordSchema } from "../../scripts/models/index.js";
import { TranscriptSchema } from "../../scripts/subtitle/model.js";
import {
  readTranscriptCache,
  transcriptCachePath,
  writeTranscriptCache,
} from "../../scripts/subtitle/asr/cache.js";

describe("asr/cache ()", () => {
  let tmpDir: string;
  let cacheDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "asr-cache-test-"));
    cacheDir = join(tmpDir, "transcript");
  });

  /** 测试体里需要写 fixture 时调一下, 等价于 mkdir -p. */
  function ensureCacheDir(): void {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("transcriptCachePath", () => {
    it("拼接 <bvid>_<cid> 到 transcript 子目录 ()", () => {
      const path = transcriptCachePath("BV1abc", "123456", cacheDir);
      expect(path).toBe(join(cacheDir, "BV1abc_123456.transcript.json"));
    });

    it("空 bvid 抛错", () => {
      expect(() => transcriptCachePath("", "123", cacheDir)).toThrow(/bvid/);
      expect(() => transcriptCachePath("  ", "123", cacheDir)).toThrow(/bvid/);
    });

    it("空 cid 抛错 (缓存 key 必含 cid 避免跨分P 污染)", () => {
      expect(() => transcriptCachePath("BV1abc", "", cacheDir)).toThrow(/cid/);
      expect(() => transcriptCachePath("BV1abc", "  ", cacheDir)).toThrow(/cid/);
    });
  });

  describe("readTranscriptCache", () => {
    it("文件不存在 → null", () => {
      expect(readTranscriptCache("BV1missing", "100", cacheDir)).toBeNull();
    });

    it("非法 JSON → null (不抛错, 走 miss 重跑)", () => {
      ensureCacheDir();
      const path = transcriptCachePath("BV1bad", "100", cacheDir);
      writeFileSync(path, "{ this is not json", "utf-8");
      expect(readTranscriptCache("BV1bad", "100", cacheDir)).toBeNull();
    });

    it("schemaVersion 错 (老 v1 缓存) → null (兼容老版本)", () => {
      ensureCacheDir();
      const path = transcriptCachePath("BV1oldschema", "100", cacheDir);
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, bvid: "BV1oldschema", cid: "100" }),
        "utf-8",
      );
      expect(readTranscriptCache("BV1oldschema", "100", cacheDir)).toBeNull();
    });

    it("transcript 不符合 TranscriptSchema → null", () => {
      ensureCacheDir();
      const path = transcriptCachePath("BV1badtranscript", "100", cacheDir);
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          cachedAt: new Date().toISOString(),
          bvid: "BV1badtranscript",
          cid: "100",
          // 缺 segments 字段, 必填
          transcript: { source: "asr", language: "zh-CN" },
          acquisition: { dataKind: "transcript", status: "success" },
          asrProvider: "funasr",
        }),
        "utf-8",
      );
      expect(readTranscriptCache("BV1badtranscript", "100", cacheDir)).toBeNull();
    });

    it("合法 v2 缓存 → 完整 CachedEntry", () => {
      ensureCacheDir();
      const entry = {
        schemaVersion: 2,
        cachedAt: new Date().toISOString(),
        bvid: "BV1ok",
        cid: "123",
        transcript: {
          source: "asr",
          language: "zh-CN",
          cid: "123",
          segments: [{ id: "s1", startSeconds: 0, endSeconds: 1, text: "hi" }],
          complete: true,
        },
        acquisition: {
          dataKind: "transcript",
          status: "success",
          source: "funasr",
          itemCount: 1,
          warnings: [],
        },
        asrProvider: "funasr",
      };
      const path = transcriptCachePath("BV1ok", "123", cacheDir);
      writeFileSync(path, JSON.stringify(entry, null, 2), "utf-8");

      const cached = readTranscriptCache("BV1ok", "123", cacheDir);
      expect(cached).not.toBeNull();
      expect(cached?.bvid).toBe("BV1ok");
      expect(cached?.cid).toBe("123");
      expect(cached?.transcript.segments[0]?.text).toBe("hi");
      expect(cached?.asrProvider).toBe("funasr");
    });
  });

  describe("writeTranscriptCache", () => {
    it("自动创建 transcript 目录", () => {
      expect(existsSync(cacheDir)).toBe(false);
      const transcript = TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        cid: "100",
        segments: [],
        complete: true,
      });
      const acquisition = AcquisitionRecordSchema.parse({
        dataKind: "transcript",
        status: "success",
        source: "funasr",
      });

      writeTranscriptCache("BV1new", "100", transcript, acquisition, cacheDir);
      expect(existsSync(cacheDir)).toBe(true);
    });

    it("写完后 read 回来数据一致 (含 schemaVersion=2 + cid)", () => {
      const transcript = TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        cid: "999",
        segments: [{ id: "s1", startSeconds: 0, endSeconds: 1, text: "写后读" }],
        complete: true,
      });
      const acquisition = AcquisitionRecordSchema.parse({
        dataKind: "transcript",
        status: "success",
        source: "funasr",
        itemCount: 1,
        warnings: ["original"],
      });

      writeTranscriptCache("BV1rw", "999", transcript, acquisition, cacheDir);
      const cached = readTranscriptCache("BV1rw", "999", cacheDir);
      expect(cached).not.toBeNull();
      expect(cached?.schemaVersion).toBe(2);
      expect(cached?.bvid).toBe("BV1rw");
      expect(cached?.cid).toBe("999");
      expect(cached?.asrProvider).toBe("funasr");
      expect(cached?.transcript.segments[0]?.text).toBe("写后读");
      expect(cached?.acquisition.warnings).toContain("original");
    });

    it("cache key 跟 transcript.cid 不一致 → 抛错", () => {
      const transcript = TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        cid: "999",  // transcript.cid = 999
        segments: [],
        complete: true,
      });
      const acquisition = AcquisitionRecordSchema.parse({
        dataKind: "transcript",
        status: "success",
        source: "funasr",
      });

      // 但 cache key 用 "1000" → 必抛错
      expect(() =>
        writeTranscriptCache("BV1mismatch", "1000", transcript, acquisition, cacheDir),
      ).toThrow(/cid 不一致/);
    });

    it("写出的 JSON 文件可被独立解析 (人读得懂)", () => {
      const transcript = TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        cid: "100",
        segments: [],
        complete: true,
      });
      const acquisition = AcquisitionRecordSchema.parse({
        dataKind: "transcript",
        status: "success",
        source: "funasr",
      });

      writeTranscriptCache("BV1human", "100", transcript, acquisition, cacheDir);
      const raw = readFileSync(transcriptCachePath("BV1human", "100", cacheDir), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.bvid).toBe("BV1human");
      expect(parsed.cid).toBe("100");
      expect(parsed.schemaVersion).toBe(2);
      expect(typeof parsed.cachedAt).toBe("string");
    });
  });

  describe("B1 契约: 跨分P 隔离", () => {
    it("同 BV 不同 cid → 各自独立 cache 文件", () => {
      const transcript = TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        segments: [],
        complete: true,
      });
      const acquisition = AcquisitionRecordSchema.parse({
        dataKind: "transcript",
        status: "success",
        source: "funasr",
      });

      // P1 跟 P2 各自一个 cache 文件
      const t1 = { ...transcript, cid: "111" };
      const t2 = { ...transcript, cid: "222" };
      writeTranscriptCache("BV1share", "111", t1, acquisition, cacheDir);
      writeTranscriptCache("BV1share", "222", t2, acquisition, cacheDir);

      // 读 P1 cache 不能拿到 P2 的 transcript
      const cached1 = readTranscriptCache("BV1share", "111", cacheDir);
      const cached2 = readTranscriptCache("BV1share", "222", cacheDir);
      expect(cached1?.cid).toBe("111");
      expect(cached2?.cid).toBe("222");

      // 物理文件分离
      const p1Path = join(cacheDir, "BV1share_111.transcript.json");
      const p2Path = join(cacheDir, "BV1share_222.transcript.json");
      expect(existsSync(p1Path)).toBe(true);
      expect(existsSync(p2Path)).toBe(true);
      expect(p1Path).not.toBe(p2Path);
    });
  });
});
