/**
 * scripts/bilibili/protobuf.ts: B 站 protobuf 共享解析工具.
 *
 * 用途: 把 B 站返回的 protobuf 二进制 (Uint8Array) 反序列化成 JS 对象.
 *
 * 关键设计:
 * - 不引入第三方 protobuf 库 (项目里目前没用, 手工实现更轻量, 避免 B 站协议变更
 *   导致需要重写生成代码)
 * - 通用 wire type 读取: 跳过未知字段, 减少播放器协议扩展带来的破坏
 * - 所有大整数用 bigint 处理, 避开 JavaScript 安全整数边界
 *
 * 复用:
 * - scripts/subtitle/bilibili-adapter.ts (M1 字幕轨发现) 内部实现了等价工具,
 *   后续 Stage 3 关闭时可抽到本文件做统一收口 (M3 阶段不动 M1 已冻结代码)
 * - 弹幕 raw-schema (M3 Stage 1) 直接用本文件
 *
 * 协议字段 (弹幕) 参考: bilibili.community.service.dm.v1.DmSegMobileReply
 *   (B 站官方 proto 定义; 本文件只读, 不生成)
 */

const TEXT_DECODER = new TextDecoder();

/** Wire field 解析后的中间表示. */
export interface WireField {
  /** 字段编号 (从 1 开始, 0 非法). */
  fieldNumber: number;
  /** Wire type: 0 varint / 1 64-bit / 2 length-delimited / 5 32-bit. */
  wireType: number;
  /** 字段值: varint/32-bit 是 bigint, length-delimited 是 Uint8Array. */
  value: bigint | Uint8Array;
}

/**
 * 读取 protobuf varint. 返回 [值, 新偏移].
 * 限制: 最多读 10 字节, 超过抛错 (单 varint 不会超过 64 bit).
 */
export function readVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;

  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, index + 1];
    shift += 7n;
  }

  throw new Error(
    `protobuf varint 解析失败: offset=${offset}, 字节不足或超过 10 字节`,
  );
}

/** 把一个 protobuf message 拆成字段;未知字段按 wire type 安全跳过. */
export function readWireFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const [key, afterKey] = readVarint(bytes, offset);
    offset = afterKey;
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 0x07n);

    if (fieldNumber <= 0) {
      throw new Error(`protobuf 非法字段编号: ${fieldNumber} at offset=${offset}`);
    }

    if (wireType === 2) {
      // length-delimited: bytes/string/embedded message
      const [len, afterLen] = readVarint(bytes, offset);
      offset = afterLen;
      const numLen = Number(len);
      if (numLen < 0 || offset + numLen > bytes.length) {
        throw new Error(
          `protobuf 长度字段越界: field=${fieldNumber}, len=${numLen}, available=${bytes.length - offset}`,
        );
      }
      const value = bytes.slice(offset, offset + numLen);
      offset += numLen;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0 || wireType === 1 || wireType === 5) {
      // varint / 64-bit / 32-bit: 都是 8 字节或 1 字节变长
      const [value, afterValue] = readVarint(bytes, offset);
      offset = afterValue;
      fields.push({ fieldNumber, wireType, value });
    } else {
      throw new Error(`protobuf 不支持的 wire type: ${wireType} (field ${fieldNumber})`);
    }
  }

  return fields;
}

/** 提取 length-delimited 字段为字节 (用于 embedded message). */
export function bytesField(fields: WireField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === 2);
  if (field === undefined) return undefined;
  if (typeof field.value === "bigint") {
    throw new Error(`protobuf 字段 ${fieldNumber} wire type 错: 期待 length-delimited, 拿到 varint`);
  }
  return field.value;
}

/** 提取 length-delimited 字段为 UTF-8 字符串. */
export function stringField(fields: WireField[], fieldNumber: number): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  if (bytes === undefined) return undefined;
  return TEXT_DECODER.decode(bytes);
}

/** 提取 varint/32-bit 字段. 32-bit 在 bigint 里是安全的 (≤ 2^53). */
export function integerField(fields: WireField[], fieldNumber: number): bigint | undefined {
  const field = fields.find((f) => f.fieldNumber === fieldNumber && (f.wireType === 0 || f.wireType === 5));
  if (field === undefined) return undefined;
  if (typeof field.value !== "bigint") {
    throw new Error(`protobuf 字段 ${fieldNumber} wire type 错: 期待 varint/32-bit, 拿到 length-delimited`);
  }
  return field.value;
}

/** 提取 varint 字段并转 number (假定 ≤ 2^31). 越界抛错. */
export function integerFieldAsNumber(fields: WireField[], fieldNumber: number): number | undefined {
  const big = integerField(fields, fieldNumber);
  if (big === undefined) return undefined;
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`protobuf 字段 ${fieldNumber} 超出 JavaScript 安全整数范围: ${big}`);
  }
  return Number(big);
}
