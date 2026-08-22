/**
 * scripts/danmaku/bilibili-adapter.ts: B 站弹幕原始 → 标准化.
 *
 * 职责:
 * 1. 按视频时长计算分段 (6min/段), 多段拉取 + 合并
 * 2. 原始字段标准化:
 *    - progress (ms) → startSeconds (s), endSeconds = startSeconds (D11 瞬时事件)
 *    - ctime (Unix 秒) → sendTime (ISO 8601)
 *    - color (RGB888 十进制) → "#RRGGBB" hex
 *    - mode (int 1-9) → enum
 *    - pool (int 0-2) → enum
 *    - id: 跨段不重复 (B 站 dmid 段间可能重复)
 * 3. 排序 + 统计 (total / segmentCount / complete)
 *
 * D12 边界: B 站原始字段名 (progress / ctime / midHash / pool) 不暴露到 Tool 层.
 */
import { z } from "zod";

import { BilibiliError } from "../bilibili/errors.js";
import {
  type RawDanmakuElem,
  type RawDanmakuReply,
  danmakuElemAsNumbers,
  decodeDanmakuReply,
} from "./bilibili-raw-schema.js";
import type { BilibiliSubtitleClient } from "../bilibili/client.js";
import {
  DanmakuSchema,
  type Danmaku,
  type DanmakuMode,
  type DanmakuPool,
  type DanmakuSegment,
  normalizeDanmakuMode,
  normalizeDanmakuPool,
} from "../models/danmaku.js";

/** 单段 6 分钟 (B 站硬编码). */
const SEGMENT_DURATION_SECONDS = 360;

/** 默认最大段数 (覆盖 72 分钟视频). 超过截断 + warning. */
const DEFAULT_MAX_SEGMENTS = 12;

/** 单段 6000 条上限 (B 站硬编码). 超过说明爆款, 截断. */
const SEGMENT_ITEM_LIMIT = 6_000;

/** Adapter 输入. */
export interface DiscoverDanmakuSegmentsInput {
  aid: number;
  cid: number;
  /** 视频总时长 (秒), 用于计算段数. 0 或缺失时按 1 段处理. */
  durationSeconds?: number;
  /** 最大段数, 默认 12. */
  maxSegments?: number;
}

/** Adapter 输出. */
export interface DiscoverDanmakuSegmentsResult {
  /** 标准化弹幕. */
  danmaku: Danmaku;
  /** 处理过程中遇到的问题 (非致命). */
  warnings: string[];
}

/**
 * 拉取 + 标准化 B 站弹幕.
 *
 * 不暴露 B 站原始字段; 失败用结构化 BilibiliError 让上层包装成 AcquisitionRecord.
 */
export async function discoverDanmakuSegments(
  client: BilibiliSubtitleClient,
  input: DiscoverDanmakuSegmentsInput,
): Promise<DiscoverDanmakuSegmentsResult> {
  const maxSegments = input.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const duration = Math.max(0, input.durationSeconds ?? 0);
  // B 站段索引 1 开始; 段数 = ceil(duration / 360)
  const totalSegments = Math.max(1, Math.ceil(duration / SEGMENT_DURATION_SECONDS));
  const segmentsToFetch = Math.min(maxSegments, totalSegments);
  const truncated = segmentsToFetch < totalSegments;

  const allElems: RawDanmakuElem[] = [];
  const warnings: string[] = [];
  let successfulSegments = 0;
  let itemTruncatedSegments = 0;

  for (let segmentIndex = 1; segmentIndex <= segmentsToFetch; segmentIndex += 1) {
    try {
      const bytes = await client.getBinary("/x/v2/dm/web/seg.so", {
        type: 1,
        oid: input.cid,
        pid: input.aid,
        segment_index: segmentIndex,
      });
      const raw = decodeDanmakuReplyFromBytes(bytes);
      if (raw.elems.length > SEGMENT_ITEM_LIMIT) {
        warnings.push(
          `segment ${segmentIndex}: 超过 ${SEGMENT_ITEM_LIMIT} 条, 已截断 (实际 ${raw.elems.length})`,
        );
        // 截断时记录原始数, 透传到 complete 公式
        itemTruncatedSegments += 1;
        allElems.push(...raw.elems.slice(0, SEGMENT_ITEM_LIMIT));
      } else {
        allElems.push(...raw.elems);
      }
      successfulSegments += 1;
    } catch (e) {
      // 单段失败不阻断, 警告后继续; successfulSegments 不递增
      warnings.push(
        `segment ${segmentIndex}: 拉取失败 - ${(e as Error).message}`,
      );
    }
  }

  if (truncated) {
    warnings.push(
      `视频时长 ${duration}s 对应 ${totalSegments} 段, 已截断到 ${segmentsToFetch} 段 (maxSegments=${maxSegments})`,
    );
  }

  // complete 必须按"成功段数"判定, 不能再用计划段数.
  // 任何段失败 → complete = false (跟 acquisition.status = partial 一致).
  // 同时考虑单段 item 截断 (itemTruncatedSegments) 跟缺时间戳 drop (在 normalizeDanmakuReply 内计 droppedInvalidCount).
  const normalized = normalizeDanmakuReply({
    elems: allElems,
  }, String(input.cid), segmentsToFetch, totalSegments, truncated, successfulSegments, itemTruncatedSegments);

  if (itemTruncatedSegments > 0) {
    warnings.push(
      `${itemTruncatedSegments} 个段内部 item 被 SEGMENT_ITEM_LIMIT (${SEGMENT_ITEM_LIMIT}) 截断, 完整度下降`,
    );
  }
  const droppedInvalidCount = Number(normalized.metadata?.droppedInvalidCount ?? 0);
  if (droppedInvalidCount > 0) {
    warnings.push(`有 ${droppedInvalidCount} 条弹幕缺少播放时间，已丢弃；数据覆盖不完整`);
  }

  return {
    danmaku: DanmakuSchema.parse(normalized),
    warnings,
  };
}

/** 解码 B 站响应字节为 RawDanmakuReply. 独立函数方便单测 mock. */
function decodeDanmakuReplyFromBytes(bytes: Uint8Array): RawDanmakuReply {
  return decodeDanmakuReply(bytes);
}

/**
 * 把 RawDanmakuReply 标准化成 Danmaku.
 *
 * 独立函数 (不依赖 client) 便于单测.
 */
export function normalizeDanmakuReply(
  raw: RawDanmakuReply,
  cid: string,
  segmentsFetched: number,
  totalSegments: number,
  truncated: boolean,
  /** 实际成功拉取的段数 (不算失败的). 0 表示"还没拉取"语义上不对, 默认 = segmentsFetched. */
  successfulSegments?: number,
  /** 单段内部 item 被 SEGMENT_ITEM_LIMIT 截断的段数. 0 = 没截断. */
  itemTruncatedSegments: number = 0,
): z.infer<typeof DanmakuSchema> {
  const segments: DanmakuSegment[] = [];
  let droppedInvalidCount = 0;

  for (const rawElem of raw.elems) {
    const nums = danmakuElemAsNumbers(rawElem as Parameters<typeof danmakuElemAsNumbers>[0]);
    if (nums.progressMs === undefined) {
      // 缺时间戳弹幕无法锚定到时间轴, 计数但不静默丢弃
      droppedInvalidCount += 1;
      continue;
    }
    const startSeconds = Math.round(nums.progressMs) / 1000;
    const sendTime = nums.ctimeSec !== undefined
      ? new Date(nums.ctimeSec * 1000).toISOString()
      : undefined;
    const id = nums.id !== undefined && sendTime !== undefined
      ? `d-${nums.ctimeSec}-${nums.id}`
      : `d-unknown-${segments.length}`;

    segments.push({
      id,
      startSeconds,
      endSeconds: startSeconds,
      text: rawElem.content ?? "",
      mode: normalizeDanmakuMode(nums.mode),
      color: rgb888ToHex(nums.color ?? 0xFFFFFF),
      midHash: rawElem.midHash,
      sendTime,
      weight: nums.weight,
      pool: normalizeDanmakuPool(nums.pool),
      metadata: {
        fontSize: nums.fontsize,
        attr: nums.attr,
        ...(rawElem.action ? { action: rawElem.action } : {}),
        ...(rawElem.idStr ? { idStr: rawElem.idStr } : {}),
      },
    });
  }

  // 按时间排序 (B 站接口应该有序, 但保险起见排一次)
  segments.sort((a, b) => a.startSeconds - b.startSeconds);

  // complete 必须用"成功段数"判定.
  // 任何段失败 → complete = false (跟 acquisition.status = partial 一致).
  // successfulSegments 不传时, 假定全部成功 (向后兼容纯函数调用).
  //
  // itemTruncatedSegments > 0 → 段数虽全成功, 但单段内部 item 被截断, complete 也为 false
  // droppedInvalidCount > 0 → 段内静默丢了缺时间戳的弹幕, complete 也为 false
  // 避免 danmaku.complete=true 跟 acquisition.status=partial 自相矛盾.
  const succeeded = successfulSegments ?? segmentsFetched;
  const itemTruncated = itemTruncatedSegments > 0;
  const hasInvalidDrops = droppedInvalidCount > 0;
  return {
    source: "bilibili_danmaku",
    language: "zh-CN",
    cid,
    provider: "bilibili_player_api",
    segments,
    total: segments.length,
    segmentCount: segmentsFetched,
    complete: !truncated && !itemTruncated && !hasInvalidDrops && succeeded === totalSegments,
    metadata: {
      totalSegments,
      successfulSegments: succeeded,
      truncated,
      itemTruncatedSegments,
      droppedInvalidCount,
    },
  };
}

/** RGB888 十进制 → "#RRGGBB" hex. */
function rgb888ToHex(value: number): string {
  // 限到 24 bit, 避免负数
  const v = value & 0xFFFFFF;
  const r = (v >> 16) & 0xFF;
  const g = (v >> 8) & 0xFF;
  const b = v & 0xFF;
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// 模式 + 池 类型再导出, 方便上层 import
export type { DanmakuMode, DanmakuPool };

// BilibiliError 在错误处理中会用到
export { BilibiliError };
