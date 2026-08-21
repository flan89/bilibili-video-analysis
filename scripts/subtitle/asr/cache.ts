/**
 * scripts/subtitle/asr/cache.ts: ASR transcript 缓存读写.
 *
 * 缓存位置: `<cacheHome>/asr/transcript/<bv>_<cid>.json` (由 paths.ts 解析)
 *路径含 cid, 避免跨分P 复用错误数据.
 * 为什么不放项目内:
 * - 跨项目可共享 (后续 M3+ 跨视频分析时同一个 BV 多次跑)
 * - 避免数据污染代码仓库 (项目目录可能被 git 管理)
 * - 避免用户清理项目目录时丢缓存
 * - 跟系统其它 cache 语义一致 (B 站 m4s URL 2 小时过期, audio 反正不会永久留)
 *
 * 缓存文件 schema (v2):
 * {
 *   schemaVersion: 2,    // 2: 引入 cid 隔离
 *   cachedAt: ISO 8601,
 *   bvid: string,
 *   cid: string,          // , 跟 transcript.cid 保持一致
 *   transcript: Transcript,
 *   acquisition: AcquisitionRecord,
 *   asrProvider: "funasr"
 * }
 *
 * 命中策略: 读 + 验证 schemaVersion + 验证 transcript/acquisition 通过 Zod.
 * 阶段 2 不做清理 (LRU/过期) — 30 天后再说, YAGNI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { AcquisitionRecordSchema, type AcquisitionRecord } from "../../models/index.js";
import { TranscriptSchema, type Transcript } from "../model.js";
import { cachePaths } from "../../lib/paths.js";

/** 缓存文件 schema 版本. 升级时拒绝读旧版, 触发 miss 重新跑. */
const CACHE_SCHEMA_VERSION = 2;

/** transcript 缓存子目录. 通过 paths.ts 解析 (BILIBILI_SKILL_CACHE_DIR 覆盖). */
const TRANSCRIPT_CACHE_DIR = join(cachePaths.asrCache(), "transcript");

/** 缓存条目 Zod schema. */
const CachedEntrySchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  cachedAt: z.string(),
  bvid: z.string().min(1),
  /** : 跨分P 隔离 key. */
  cid: z.string().min(1),
  transcript: TranscriptSchema,
  acquisition: AcquisitionRecordSchema,
  asrProvider: z.literal("funasr"),
});

/** 缓存条目 (验证后). */
export type CachedEntry = z.infer<typeof CachedEntrySchema>;

/**
 * 解析 transcript 缓存文件绝对路径. 不做存在性检查.
 *
 * 路径含 cid, 避免跨分P 复用错误数据.
 * 导出此函数以便测试断言 (不会写到真实缓存目录).
 */
export function transcriptCachePath(
  bvid: string,
  cid: string,
  cacheDir: string = TRANSCRIPT_CACHE_DIR,
): string {
  if (!bvid || !bvid.trim()) {
    throw new Error("bvid 不能为空");
  }
  if (!cid || !cid.trim()) {
    throw new Error("cid 不能为空 (缓存 key 必须含 cid 避免跨分P 污染)");
  }
  return join(cacheDir, `${bvid}_${cid}.transcript.json`);
}

/** 读取缓存. 不存在或 schema 验证失败时返回 null (不抛错, 走 miss 重新跑). */
export function readTranscriptCache(
  bvid: string,
  cid: string,
  cacheDir?: string,
): CachedEntry | null {
  const path = transcriptCachePath(bvid, cid, cacheDir);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CachedEntrySchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

/** 写入缓存. transcript/acquisition 必须已通过 Zod 验证. 失败抛错 (写失败是异常路径). */
export function writeTranscriptCache(
  bvid: string,
  cid: string,
  transcript: Transcript,
  acquisition: AcquisitionRecord,
  cacheDir?: string,
): void {
  const path = transcriptCachePath(bvid, cid, cacheDir);
  const dir = cacheDir ?? TRANSCRIPT_CACHE_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // 关键契约: cache 文件的 cid 必须跟 transcript.cid 一致, 避免 错位污染.
  if (transcript.cid && transcript.cid !== cid) {
    throw new Error(
      `cid 不一致: cache key 用 ${cid}, 但 transcript.cid=${transcript.cid}`,
    );
  }
  const entry: CachedEntry = CachedEntrySchema.parse({
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachedAt: new Date().toISOString(),
    bvid,
    cid,
    transcript,
    acquisition,
    asrProvider: "funasr",
  });
  writeFileSync(path, JSON.stringify(entry, null, 2), "utf-8");
}

/** 测试/调试用: 缓存根目录 (供测试临时改写). */
export const TRANSCRIPT_CACHE_DIR_FOR_TEST = TRANSCRIPT_CACHE_DIR;
