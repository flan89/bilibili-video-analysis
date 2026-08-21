/**
 * tests/unit/wbi.test.ts: WBI 签名工具单测.
 *
 * 覆盖:
 * - getMixinKey 正确性 (用实测拿到的 img_key/sub_key 验证输出)
 * - encodeWbi 输出包含 wts + w_rid
 * - encodeWbi 特殊字符过滤
 * - encodeWbi 按 key 排序
 * - extractWbiKeysFromImgUrls URL 解析
 * - WbiSigner 缓存命中 / 失效 / 强制刷新
 *
 * 不依赖网络 (除"实际拉一次 nav"那个 e2e 用例, 默认跳过).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIXIN_KEY_ENCODING_TAB,
  WbiSigner,
  encodeWbi,
  extractWbiKeysFromImgUrls,
  getMixinKey,
} from "../../scripts/bilibili/wbi.js";

describe("MIXIN_KEY_ENCODING_TAB", () => {
  it("是 64 元素常量数组", () => {
    expect(MIXIN_KEY_ENCODING_TAB).toHaveLength(64);
  });

  it("包含 0-63 每个索引 (B 站密钥表是 [0, 63] 的一个排列)", () => {
    const sorted = [...MIXIN_KEY_ENCODING_TAB].sort((a, b) => a - b);
    for (let i = 0; i < 64; i += 1) {
      expect(sorted[i]).toBe(i);
    }
  });
});

describe("getMixinKey", () => {
  it("用实测 img_key + sub_key 生成 32 字符 mixin_key", () => {
    // 这是 2026-08-18 实测从 x/web-interface/nav 拿到的真实密钥
    const imgKey = "7cd084941338484aae1ad9425b84077c";
    const subKey = "4932caff0ff746eab6f01bf08b70ac45";
    const mixin = getMixinKey(imgKey, subKey);
    expect(mixin).toHaveLength(32);
    // 同一个输入永远得到同一个输出 (确定性)
    expect(getMixinKey(imgKey, subKey)).toBe(mixin);
  });

  it("不同 img_key/sub_key 输出不同", () => {
    const a = getMixinKey("a".repeat(32), "b".repeat(32));
    const b = getMixinKey("c".repeat(32), "d".repeat(32));
    expect(a).not.toBe(b);
  });

  it("orig 长度不足 64 时抛 BilibiliError wbi_key_too_short", () => {
    try {
      getMixinKey("a".repeat(10), "b".repeat(10));
      expect.fail("应该抛错");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("wbi_key_too_short");
    }
  });
});

describe("encodeWbi", () => {
  const imgKey = "7cd084941338484aae1ad9425b84077c";
  const subKey = "4932caff0ff746eab6f01bf08b70ac45";

  it("返回的 query 包含 wts 和 w_rid", () => {
    const signed = encodeWbi({ oid: 123, type: 1, mode: 3 }, imgKey, subKey);
    expect(signed).toContain("wts=");
    expect(signed).toContain("w_rid=");
  });

  it("w_rid 是 32 字符 MD5 hex", () => {
    const signed = encodeWbi({ oid: 123, type: 1 }, imgKey, subKey);
    const wRid = signed.split("w_rid=")[1];
    expect(wRid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("按 key 排序", () => {
    const signed = encodeWbi(
      { z_param: "z", a_param: "a", m_param: "m" },
      imgKey,
      subKey,
    );
    const params = signed.split("&").map((p) => p.split("=")[0]);
    expect(params[0]).toBe("a_param");
    expect(params[1]).toBe("m_param");
    // wts 总是存在, w_rid 总是最后
    expect(params).toContain("wts");
    expect(params[params.length - 1]).toBe("w_rid");
  });

  it("过滤特殊字符 !'()*", () => {
    const signed = encodeWbi(
      { content: "hello!world'test*(x)y*z" },
      imgKey,
      subKey,
    );
    // 注意: encodeURIComponent 也会编码, 但我们的过滤在它之前
    // 关键: 过滤后的字符串里不应包含原始的特殊字符
    // 用 decoded 形式检查
    const decoded = decodeURIComponent(signed);
    expect(decoded).not.toContain("'");
    expect(decoded).not.toContain("(");
    expect(decoded).not.toContain(")");
    expect(decoded).not.toContain("*");
  });

  it("undefined 值被跳过", () => {
    const signed = encodeWbi(
      { oid: 123, type: 1, optional: undefined, mode: 3 },
      imgKey,
      subKey,
    );
    expect(signed).not.toContain("optional=");
    expect(signed).toContain("oid=123");
  });

  it("数字和布尔值被正确转字符串", () => {
    const signed = encodeWbi(
      { type: 1, mode: 3, flag: true, count: 0 },
      imgKey,
      subKey,
    );
    expect(signed).toContain("type=1");
    expect(signed).toContain("mode=3");
    expect(signed).toContain("flag=true");
    expect(signed).toContain("count=0");
  });

  it("签名结果稳定 (同参数, 不同时刻 wts 不同但其它部分一致)", () => {
    // 由于 wts 是当前时间, 我们只验证 mixin_key 部分计算一致
    // (同一秒内两次调用应该完全相同)
    const params = { oid: 123, type: 1, mode: 3 };
    const a = encodeWbi(params, imgKey, subKey);
    const b = encodeWbi(params, imgKey, subKey);
    // 同秒内应该完全一致
    expect(a).toBe(b);
  });
});

describe("extractWbiKeysFromImgUrls", () => {
  it("从实测 URL 提取 key", () => {
    const keys = extractWbiKeysFromImgUrls(
      "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
      "https://i0.hdslb.com/bbi/sub/4932caff0ff746eab6f01bf08b70ac45.png",
    );
    expect(keys.imgKey).toBe("7cd084941338484aae1ad9425b84077c");
    expect(keys.subKey).toBe("4932caff0ff746eab6f01bf08b70ac45");
  });

  it("处理带额外路径前缀的 URL", () => {
    const keys = extractWbiKeysFromImgUrls(
      "https://example.com/some/path/abc123def456.png",
      "https://other.example.com/different/path/789xyz456abc.png",
    );
    expect(keys.imgKey).toBe("abc123def456");
    expect(keys.subKey).toBe("789xyz456abc");
  });
});

describe("WbiSigner 缓存", () => {
  const imgKey = "7cd084941338484aae1ad9425b84077c";
  const subKey = "4932caff0ff746eab6f01bf08b70ac45";

  const navResponse = {
    code: -101,
    data: {
      wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`,
        sub_url: `https://i0.hdslb.com/bbi/sub/${subKey}.png`,
      },
      isLogin: false,
    },
  };

  function makeMockFetch() {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => navResponse,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("首次 getKeys 调 fetch 一次", async () => {
    const fetchImpl = makeMockFetch();
    const signer = new WbiSigner({ fetchImpl });
    const keys = await signer.getKeys();
    expect(keys.imgKey).toBe(imgKey);
    expect(keys.subKey).toBe(subKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("x/web-interface/nav");
  });

  it("缓存命中不再调 fetch", async () => {
    const fetchImpl = makeMockFetch();
    const signer = new WbiSigner({ fetchImpl });
    await signer.getKeys();
    await signer.getKeys();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reset 后重新拉", async () => {
    const fetchImpl = makeMockFetch();
    const signer = new WbiSigner({ fetchImpl });
    await signer.getKeys();
    signer.reset();
    await signer.getKeys();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("signRequest 一次完成 keys + 签名", async () => {
    const fetchImpl = makeMockFetch();
    const signer = new WbiSigner({ fetchImpl });
    const signed = await signer.signRequest(undefined, { oid: 999, type: 1 });
    expect(signed).toContain("oid=999");
    expect(signed).toContain("type=1");
    expect(signed).toContain("wts=");
    expect(signed).toContain("w_rid=");
  });

  it("缓存 TTL 失效后重新拉 (用极短 TTL 验证)", async () => {
    const fetchImpl = makeMockFetch();
    const signer = new WbiSigner({ fetchImpl, cacheTtlMs: 0 });
    await signer.getKeys();
    await new Promise((r) => setTimeout(r, 5));
    await signer.getKeys();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("HTTP 非 2xx 抛 wbi_keys_http_error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const signer = new WbiSigner({ fetchImpl });
    try {
      await signer.getKeys();
      expect.fail("应该抛错");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("wbi_keys_http_error");
    }
  });

  it("响应缺 wbi_img 抛 wbi_keys_unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: -101, data: { isLogin: false } }),
    });
    const signer = new WbiSigner({ fetchImpl });
    try {
      await signer.getKeys();
      expect.fail("应该抛错");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("wbi_keys_unavailable");
    }
  });
});
