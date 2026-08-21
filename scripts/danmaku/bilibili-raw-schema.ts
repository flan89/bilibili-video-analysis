/**
 * scripts/danmaku/bilibili-raw-schema.ts: B 站弹幕 protobuf 原始响应 schema.
 *
 * 协议: `x/v2/dm/web/seg.so?type=1&oid={cid}&pid={aid}&segment_index={n}`
 * 消息: bilibili.community.service.dm.v1.DmSegMobileReply
 *
 * 注意: B 站协议含未公开字段 (高级弹幕 / 互动弹幕 / 字幕弹幕 / BAS 等),
 * 本文件只读 14 个常用字段, 其它跳过 (依赖 protobuf 工具的 wire type 安全跳过).
 *
 * D12 边界: 本文件只描述 B 站原始字段, 业务标准化 (毫秒→秒 / RGB888→hex 等)
 * 在 danmaku-adapter.ts 完成, 不在这里混入业务逻辑.
 */
import { z } from "zod";

import {
  integerField,
  readWireFields,
  stringField,
} from "../bilibili/protobuf.js";

/**
 * 单条弹幕原始字段.
 *
 * 所有数字字段都用 bigint 承载 (跟 protobuf wire format 一致),
 * 业务层 adapter 负责转 number.
 */
export interface RawDanmakuElem {
  id?: bigint;
  progress?: bigint; // 毫秒
  mode?: bigint;
  fontsize?: bigint;
  color?: bigint; // RGB888 十进制
  midHash?: string;
  content?: string;
  ctime?: bigint; // Unix 秒
  weight?: bigint;
  action?: string;
  pool?: bigint;
  idStr?: string;
  attr?: bigint;
  animation?: string;
}

/** DmSegMobileReply 反序列化结果. */
export interface RawDanmakuReply {
  elems: RawDanmakuElem[];
}

/** Zod schema (给单测 / 上层验证用). */
export const RawDanmakuElemSchema = z.object({
  id: z.bigint().optional(),
  progress: z.bigint().optional(),
  mode: z.bigint().optional(),
  fontsize: z.bigint().optional(),
  color: z.bigint().optional(),
  midHash: z.string().optional(),
  content: z.string().optional(),
  ctime: z.bigint().optional(),
  weight: z.bigint().optional(),
  action: z.string().optional(),
  pool: z.bigint().optional(),
  idStr: z.string().optional(),
  attr: z.bigint().optional(),
  animation: z.string().optional(),
}).passthrough();
export type ValidatedRawDanmakuElem = z.infer<typeof RawDanmakuElemSchema>;

export const RawDanmakuReplySchema = z.object({
  elems: z.array(RawDanmakuElemSchema),
});
export type ValidatedRawDanmakuReply = z.infer<typeof RawDanmakuReplySchema>;

/**
 * 解析 DmSegMobileReply 字节流.
 *
 * 已知局限: 高级弹幕 / 互动弹幕 / 字幕弹幕的 embedded message 内容不解析 (跳过),
 * 弹幕正文只保留 mode=1 普通弹幕等基础类型; 高级弹幕业务方需要时再扩展.
 */
export function decodeDanmakuReply(bytes: Uint8Array): RawDanmakuReply {
  // B 站 DmSegMobileReply.elems 是 `repeated DanmakuElem`, wire 编码是 unpacked:
  // 顶层 schema 出现多次 `field 1 (length-delimited DanmakuElem)`, 每个 value 直接是
  // 一个 DanmakuElem 字节流. 不需要再 wrap 一层 `bytesField(topFields, 1)`.
  const topFields = readWireFields(bytes);
  const elems: RawDanmakuElem[] = [];
  for (const f of topFields) {
    if (f.fieldNumber !== 1 || f.wireType !== 2) continue;
    const elemBytes = f.value as Uint8Array;
    const fields = readWireFields(elemBytes);
    elems.push(parseDanmakuElem(fields));
  }
  return { elems };
}

function parseDanmakuElem(fields: { fieldNumber: number; wireType: number; value: bigint | Uint8Array }[]): RawDanmakuElem {
  return {
    id: integerField(fields, 1),
    progress: integerField(fields, 2),
    mode: integerField(fields, 3),
    fontsize: integerField(fields, 4),
    color: integerField(fields, 5),
    midHash: stringField(fields, 6),
    content: stringField(fields, 7),
    ctime: integerField(fields, 8),
    weight: integerField(fields, 9),
    action: stringField(fields, 10),
    pool: integerField(fields, 11),
    idStr: stringField(fields, 12),
    attr: integerField(fields, 13),
    animation: stringField(fields, 14),
  };
}

/** 工具: 把 wire fields 转 number 字段 (上层 convenience). */
export function danmakuElemAsNumbers(elem: RawDanmakuElem): {
  id?: number;
  progressMs?: number;
  mode?: number;
  fontsize?: number;
  color?: number;
  ctimeSec?: number;
  weight?: number;
  pool?: number;
  attr?: number;
} {
  return {
    id: elem.id === undefined ? undefined : integerFieldAsNumberFromBig(elem.id),
    progressMs: elem.progress === undefined ? undefined : integerFieldAsNumberFromBig(elem.progress),
    mode: elem.mode === undefined ? undefined : integerFieldAsNumberFromBig(elem.mode),
    fontsize: elem.fontsize === undefined ? undefined : integerFieldAsNumberFromBig(elem.fontsize),
    color: elem.color === undefined ? undefined : integerFieldAsNumberFromBig(elem.color),
    ctimeSec: elem.ctime === undefined ? undefined : integerFieldAsNumberFromBig(elem.ctime),
    weight: elem.weight === undefined ? undefined : integerFieldAsNumberFromBig(elem.weight),
    pool: elem.pool === undefined ? undefined : integerFieldAsNumberFromBig(elem.pool),
    attr: elem.attr === undefined ? undefined : integerFieldAsNumberFromBig(elem.attr),
  } as {
    id?: number;
    progressMs?: number;
    mode?: number;
    fontsize?: number;
    color?: number;
    ctimeSec?: number;
    weight?: number;
    pool?: number;
    attr?: number;
  };
}

function integerFieldAsNumberFromBig(value: bigint): number | undefined {
  // B 站弹幕 id 是 uint64, 经常超过 Number.MAX_SAFE_INTEGER (~9e15).
  // 对无法精确表示的 bigint 返回 undefined, 让上层用 idStr / ctime 等其它标识.
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}
