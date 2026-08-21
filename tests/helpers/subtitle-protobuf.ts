import type { RawSubtitleView } from "../../scripts/subtitle/bilibili-raw-schema.js";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function varint(value: bigint): Uint8Array {
  const output: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    output.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(output);
}

function bytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concat(
    varint(BigInt((fieldNumber << 3) | 2)),
    varint(BigInt(value.length)),
    value,
  );
}

function stringField(fieldNumber: number, value?: string): Uint8Array {
  return value === undefined ? new Uint8Array() : bytesField(fieldNumber, encoder.encode(value));
}

function integerField(fieldNumber: number, value?: number | bigint): Uint8Array {
  return value === undefined
    ? new Uint8Array()
    : concat(varint(BigInt(fieldNumber << 3)), varint(BigInt(value)));
}

/** 仅供 fixture 测试生成播放器当前使用的最小 protobuf 响应。 */
export function encodeSubtitleViewFixture(view: RawSubtitleView): Uint8Array {
  const trackMessages = view.subtitles.map((track) => {
    const trackMessage = concat(
      integerField(1, BigInt(track.id)),
      stringField(2, track.id),
      stringField(3, track.lan),
      stringField(4, track.lanDoc),
      stringField(5, track.subtitleUrl),
      integerField(7, track.type),
      stringField(8, track.lanDocBrief),
      integerField(10, track.aiStatus),
      integerField(13, track.format),
    );
    return bytesField(3, trackMessage);
  });
  const videoSubtitle = concat(
    stringField(1, view.lan),
    stringField(2, view.lanDoc),
    ...trackMessages,
  );
  return bytesField(1, videoSubtitle);
}
