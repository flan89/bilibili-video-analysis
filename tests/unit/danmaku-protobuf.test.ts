/**
 * tests/unit/danmaku-protobuf.test.ts: 弹幕 protobuf 解析单测.
 *
 * 覆盖:
 * - 共享 protobuf 工具 (scripts/bilibili/protobuf.ts)
 * - 弹幕 raw-schema 反序列化 (scripts/danmaku/bilibili-raw-schema.ts)
 * - 标准化转换 (rgb888ToHex / mode / pool 等)
 *
 * 不依赖网络, 用手工编的最小 fixture 验证.
 */
import { describe, expect, it } from "vitest";

import {
  bytesField,
  integerField,
  integerFieldAsNumber,
  readVarint,
  readWireFields,
  stringField,
} from "../../scripts/bilibili/protobuf.js";
import {
  danmakuElemAsNumbers,
  decodeDanmakuReply,
  RawDanmakuReplySchema,
} from "../../scripts/danmaku/bilibili-raw-schema.js";
import {
  DanmakuPoolSchema,
  DanmakuSchema,
  normalizeDanmakuMode,
  normalizeDanmakuPool,
} from "../../scripts/models/danmaku.js";
import {
  normalizeDanmakuReply,
} from "../../scripts/danmaku/bilibili-adapter.js";

describe("protobuf 工具", () => {
  describe("readVarint", () => {
    it("读 1 字节 varint (值 < 128)", () => {
      // field tag = (1 << 3) | 0 = 0x08 (field 1 varint)
      const [value, next] = readVarint(new Uint8Array([0x08]), 0);
      expect(value).toBe(8n);
      expect(next).toBe(1);
    });

    it("读多字节 varint (值 ≥ 128)", () => {
      // 300 = 0xAC 0x02 (varint: 0xAC=0b10101100, 0x02=0b00000010 → 0x12C=300)
      const [value, next] = readVarint(new Uint8Array([0xac, 0x02]), 0);
      expect(value).toBe(300n);
      expect(next).toBe(2);
    });

    it("从非零 offset 读", () => {
      // [garbage, 0x08] → 从 offset 1 读
      const [value, next] = readVarint(new Uint8Array([0xff, 0x08]), 1);
      expect(value).toBe(8n);
      expect(next).toBe(2);
    });
  });

  describe("readWireFields", () => {
    it("读 1 个 varint 字段", () => {
      // field 1, varint 0x2a (= 42)
      const fields = readWireFields(new Uint8Array([0x08, 0x2a]));
      expect(fields).toHaveLength(1);
      expect(fields[0]?.fieldNumber).toBe(1);
      expect(fields[0]?.wireType).toBe(0);
      expect(fields[0]?.value).toBe(42n);
    });

    it("读 1 个 length-delimited 字符串字段", () => {
      // field 1, length-delimited, "hi" (2 bytes)
      // [tag 0x0a] [len 0x02] ['h', 'i']
      const fields = readWireFields(new Uint8Array([0x0a, 0x02, 0x68, 0x69]));
      expect(fields).toHaveLength(1);
      expect(fields[0]?.fieldNumber).toBe(1);
      expect(fields[0]?.wireType).toBe(2);
      const value = fields[0]?.value;
      expect(value).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(value as Uint8Array)).toBe("hi");
    });

    it("读 1 个 embedded message (nested)", () => {
      // field 3, length-delimited, 内含 field 1 varint 42
      // tag = (3<<3)|2 = 0x1a
      // [0x1a] [0x02] [0x08] [0x2a]
      const fields = readWireFields(new Uint8Array([0x1a, 0x02, 0x08, 0x2a]));
      expect(fields).toHaveLength(1);
      expect(fields[0]?.fieldNumber).toBe(3);
      const inner = fields[0]?.value as Uint8Array;
      const innerFields = readWireFields(inner);
      expect(innerFields[0]?.value).toBe(42n);
    });

    it("空字节", () => {
      const fields = readWireFields(new Uint8Array([]));
      expect(fields).toHaveLength(0);
    });
  });

  describe("字段访问 helpers", () => {
    const sampleFields = readWireFields(new Uint8Array([
      0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, // field 1 string "hello"
      0x10, 0x2a, // field 2 varint 42
      0x18, 0xff, 0xff, 0xff, 0xff, 0x07, // field 3 varint 0x7FFFFFFF (max int32)
    ]));

    it("stringField", () => {
      expect(stringField(sampleFields, 1)).toBe("hello");
      expect(stringField(sampleFields, 99)).toBeUndefined();
    });

    it("integerField", () => {
      expect(integerField(sampleFields, 2)).toBe(42n);
      expect(integerField(sampleFields, 3)).toBe(2147483647n);
      expect(integerField(sampleFields, 99)).toBeUndefined();
    });

    it("integerFieldAsNumber", () => {
      expect(integerFieldAsNumber(sampleFields, 2)).toBe(42);
    });

    it("bytesField", () => {
      const bytes = bytesField(sampleFields, 1);
      expect(new TextDecoder().decode(bytes!)).toBe("hello");
    });
  });
});

describe("弹幕 raw-schema", () => {
  /**
   * 手工编一个最小 DmSegMobileReply:
   * - 1 个 DanmakuElem, field 1-7 都填
   *
   * DanmakuElem {
   *   int64 id = 1;          → tag 0x08, value (varint)
   *   int32 progress = 2;    → tag 0x10, value
   *   int32 mode = 3;        → tag 0x18, value
   *   int32 fontsize = 4;    → tag 0x20, value
   *   uint32 color = 5;      → tag 0x28, value
   *   string midHash = 6;    → tag 0x32, length, bytes
   *   string content = 7;    → tag 0x3a, length, bytes
   * }
   *
   * DmSegMobileReply { repeated DanmakuElem elems = 1; } → packed embedded
   * 但 B 站实际是 unpacked 连续 DanmakuElem, 所以顶层 field 1 (length-delimited)
   * 内容直接是 DanmakuElem 字节流
   */
  function buildSingleDanmakuBytes(): Uint8Array {
    // 单个 DanmakuElem 内部:
    // id=12345, progress=1234ms, mode=1, fontsize=25, color=0xFFFFFF, midHash="abc123", content="hello"
    const elem = new Uint8Array([
      0x08, 0xb9, 0x60, // id = 12345 varint
      0x10, 0xd2, 0x09, // progress = 1234 varint
      0x18, 0x01, // mode = 1
      0x20, 0x19, // fontsize = 25
      0x28, 0xff, 0xff, 0xff, 0x07, // color = 0xFFFFFF (varint: 0xFF 0xFF 0xFF 0x07)
      0x32, 0x06, 0x61, 0x62, 0x63, 0x31, 0x32, 0x33, // midHash "abc123"
      0x3a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, // content "hello"
    ]);
    // 顶层 elems 字段: tag 0x0a, length=elem.length, elem bytes
    const top = new Uint8Array([
      0x0a, elem.length, ...elem,
    ]);
    return top;
  }

  it("decodeDanmakuReply 解析单条 DanmakuElem", () => {
    const bytes = buildSingleDanmakuBytes();
    const result = decodeDanmakuReply(bytes);

    expect(result.elems).toHaveLength(1);
    const elem = result.elems[0]!;
    expect(elem.id).toBe(12345n);
    expect(elem.progress).toBe(1234n);
    expect(elem.mode).toBe(1n);
    expect(elem.fontsize).toBe(25n);
    expect(elem.color).toBe(0xFFFFFFn);
    expect(elem.midHash).toBe("abc123");
    expect(elem.content).toBe("hello");
  });

  it("decodeDanmakuReply 接受空字节 → 空 elems", () => {
    const result = decodeDanmakuReply(new Uint8Array([]));
    expect(result.elems).toHaveLength(0);
  });

  it("decodeDanmakuReply 跳过未知 wire type 的字段", () => {
    // field 99 wire type 0, varint 1 (B 站未来可能加的字段, 我们跳过)
    const elem = new Uint8Array([
      0x08, 0x01, // id = 1
      0x10, 0x01, // progress = 1ms
      // field 99 (未知), wire type 0, value 1
      // tag = (99 << 3) | 0 = 792, varint = 0x98 0x06
      0x98, 0x06, 0x01,
      0x3a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, // content "hello"
    ]);
    const top = new Uint8Array([0x0a, elem.length, ...elem]);
    const result = decodeDanmakuReply(top);
    expect(result.elems).toHaveLength(1);
    expect(result.elems[0]?.content).toBe("hello");
  });

  it("danmakuElemAsNumbers 把 bigint 转 number", () => {
    const result = decodeDanmakuReply(buildSingleDanmakuBytes());
    const nums = danmakuElemAsNumbers(result.elems[0]!);
    expect(nums.id).toBe(12345);
    expect(nums.progressMs).toBe(1234);
    expect(nums.mode).toBe(1);
    expect(nums.color).toBe(0xFFFFFF);
  });

  it("RawDanmakuReplySchema Zod 验证通过", () => {
    const result = decodeDanmakuReply(buildSingleDanmakuBytes());
    expect(() => RawDanmakuReplySchema.parse(result)).not.toThrow();
  });
});

describe("弹幕 model 标准化", () => {
  describe("normalizeDanmakuMode", () => {
    it("1-3 → normal", () => {
      expect(normalizeDanmakuMode(1)).toBe("normal");
      expect(normalizeDanmakuMode(2)).toBe("normal");
      expect(normalizeDanmakuMode(3)).toBe("normal");
    });

    it("4-9 各对应专属模式", () => {
      expect(normalizeDanmakuMode(4)).toBe("bottom");
      expect(normalizeDanmakuMode(5)).toBe("top");
      expect(normalizeDanmakuMode(6)).toBe("reverse");
      expect(normalizeDanmakuMode(7)).toBe("advanced");
      expect(normalizeDanmakuMode(8)).toBe("code");
      expect(normalizeDanmakuMode(9)).toBe("bas");
    });

    it("未知 mode 兜底为 normal", () => {
      expect(normalizeDanmakuMode(99)).toBe("normal");
      expect(normalizeDanmakuMode(undefined)).toBe("normal");
      expect(normalizeDanmakuMode(0)).toBe("normal");
    });
  });

  describe("normalizeDanmakuPool", () => {
    it("0/1/2 各对应专属池", () => {
      expect(normalizeDanmakuPool(0)).toBe("normal");
      expect(normalizeDanmakuPool(1)).toBe("subtitle");
      expect(normalizeDanmakuPool(2)).toBe("special");
    });

    it("未知 pool 兜底为 normal", () => {
      expect(normalizeDanmakuPool(5)).toBe("normal");
      expect(normalizeDanmakuPool(undefined)).toBe("normal");
    });
  });

  describe("DanmakuSchema", () => {
    it("Zod 验证完整 Danmaku", () => {
      const danmaku = {
        source: "bilibili_danmaku",
        language: "zh-CN",
        cid: "123",
        provider: "bilibili_player_api",
        segments: [
          {
            id: "d-1234-5678",
            startSeconds: 1.5,
            endSeconds: 1.5,
            text: "test",
            mode: "normal",
            color: "#FFFFFF",
            pool: "normal",
          },
        ],
        total: 1,
        segmentCount: 1,
        complete: true,
      };
      expect(() => DanmakuSchema.parse(danmaku)).not.toThrow();
    });

    it("保留平台返回的大于 10 的 weight，不让单条真实数据拖垮整段弹幕", () => {
      const result = normalizeDanmakuReply(
        {
          elems: [
            {
              id: 1n,
              progress: 1000n,
              content: "真实范围回归样本",
              weight: 11n,
            },
          ],
        },
        "999",
        1,
        1,
        false,
      );

      expect(result.segments[0]?.weight).toBe(11);
      expect(() => DanmakuSchema.parse(result)).not.toThrow();
    });

    it("DanmakuPoolSchema 接受合法池", () => {
      expect(DanmakuPoolSchema.parse("normal")).toBe("normal");
      expect(DanmakuPoolSchema.parse("subtitle")).toBe("subtitle");
      expect(DanmakuPoolSchema.parse("special")).toBe("special");
    });
  });
});

describe("adapter: normalizeDanmakuReply", () => {
  it("标准化: ms → s, RGB888 → hex, mode int → enum, ctime → ISO", () => {
    const result = normalizeDanmakuReply(
      {
        elems: [
          {
            id: 12345n,
            progress: 1234n, // 1.234s
            mode: 5n, // top
            fontsize: 25n,
            color: 0xFF0000n, // 红
            midHash: "abc",
            content: "test",
            ctime: 1700000000n, // 2023-11-14T22:13:20Z
            weight: 3n,
            pool: 1n, // subtitle
          },
        ],
      },
      "999",
      1,
      1,
      false,
    );

    expect(result.cid).toBe("999");
    expect(result.segments[0]?.startSeconds).toBe(1.234);
    expect(result.segments[0]?.endSeconds).toBe(1.234);
    expect(result.segments[0]?.mode).toBe("top");
    expect(result.segments[0]?.color).toBe("#FF0000");
    expect(result.segments[0]?.pool).toBe("subtitle");
    expect(result.segments[0]?.sendTime).toBe("2023-11-14T22:13:20.000Z");
    expect(result.segments[0]?.id).toBe("d-1700000000-12345");
    expect(result.total).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("缺 progress 的弹幕被跳过", () => {
    const result = normalizeDanmakuReply(
      {
        elems: [
          { id: 1n, content: "no progress" },
          { id: 2n, progress: 1000n, content: "ok" },
        ],
      },
      "999",
      1,
      1,
      false,
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.text).toBe("ok");
    expect(result.complete).toBe(false);
    expect(result.metadata?.droppedInvalidCount).toBe(1);
    expect(result.total).toBe(1); // 跳过的不计 total
  });

  it("truncated=true 时 complete=false", () => {
    const result = normalizeDanmakuReply(
      { elems: [] },
      "999",
      1,
      5,
      true,
    );
    expect(result.complete).toBe(false);
    expect(result.segmentCount).toBe(1);
  });

  it("successfulSegments < totalSegments 时 complete=false (即使 truncated=false)", () => {
    // 10 段计划拉, 9 段成功 1 段失败 → complete 必须 false
    // 跟 acquisition.status = partial 一致
    const result = normalizeDanmakuReply(
      { elems: [] },
      "999",
      10,
      10,
      false,
      9,
    );
    expect(result.complete).toBe(false);
    expect(result.segmentCount).toBe(10);
    expect(result.metadata?.successfulSegments).toBe(9);
  });

  it("successfulSegments 缺省时, 假定全部成功 (向后兼容纯函数调用)", () => {
    const result = normalizeDanmakuReply(
      { elems: [] },
      "999",
      5,
      5,
      false,
      // 缺省 successfulSegments
    );
    expect(result.complete).toBe(true);
    expect(result.metadata?.successfulSegments).toBe(5);
  });

  it("successfulSegments === totalSegments 且非 truncated → complete=true", () => {
    const result = normalizeDanmakuReply(
      { elems: [] },
      "999",
      5,
      5,
      false,
      5,
    );
    expect(result.complete).toBe(true);
  });
});
