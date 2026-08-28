/**
 * asr/runner.ts 单元测试: 覆盖 spawn pipeline.py 的各种路径
 * (不依赖网络, mock child_process.spawn + cache 模块, 避免真实文件系统)
 *
 *cid 必填, 写缓存时强制带 cid
 */
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAsrTranscript } from "../../scripts/subtitle/asr/runner.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../../scripts/lib/paths.js", () => ({
  dataPaths: { asrVenvPython: () => "/tmp/asr-venv/bin/python" },
  cachePaths: { asrWork: () => "/tmp/bilibili-video-analysis-test/asr/work" },
  runtimePaths: { pipeline: () => "/tmp/skill/runtime/python/pipeline.py" },
}));

// mock 掉 cache 模块, 默认无缓存, 不依赖真实文件系统
vi.mock("../../scripts/subtitle/asr/cache.js", () => ({
  readTranscriptCache: vi.fn().mockReturnValue(null),
  writeTranscriptCache: vi.fn(),
  transcriptCachePath: vi.fn().mockReturnValue("/tmp/mock-cache.json"),
}));

// 单元测试只验证 runner 分支；真实文件、版本与模型目录由 doctor/paths 测试覆盖。
vi.mock("../../scripts/lib/asr-runtime.js", () => ({
  inspectAsrRuntime: vi.fn(() => ({
    ready: true,
    checks: {},
    details: {},
    state: {
      runtimeManifestVersion: 1,
      asrEnvironmentVersion: 1,
      preparedAt: "2026-08-20T00:00:00.000Z",
      pythonVersion: "3.12.0",
      models: {
        fsmnVad: { id: "vad", revision: "v2.0.4", path: "/tmp/vad" },
        senseVoice: { id: "sense", revision: "v2.0.4", path: "/tmp/sense" },
      },
    },
  })),
}));

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockCache = await import("../../scripts/subtitle/asr/cache.js");
const mockReadTranscriptCache = vi.mocked(mockCache.readTranscriptCache);
const mockWriteTranscriptCache = vi.mocked(mockCache.writeTranscriptCache);

function makeChildProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  errorEvent?: Error;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable | null;
    stderr: Readable | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = opts.stdout !== undefined ? Readable.from([Buffer.from(opts.stdout, "utf-8")]) : null;
  child.stderr = opts.stderr !== undefined ? Readable.from([Buffer.from(opts.stderr, "utf-8")]) : null;
  child.kill = vi.fn();

  // 异步触发 close / error 事件
  setImmediate(() => {
    if (opts.errorEvent) {
      child.emit("error", opts.errorEvent);
    }
    child.emit("close", opts.exitCode);
  });

  return child;
}

const validSuccessStdout = JSON.stringify({
  success: true,
  transcript: {
    source: "asr",
    language: "zh-CN",
    cid: "123",
    segments: [
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "测试" },
    ],
    complete: true,
  },
  acquisition: { status: "success", source: "funasr", warnings: [] },
});

const validFailureStdout = JSON.stringify({
  success: false,
  transcript: null,
  acquisition: {
    status: "missing",
    source: "funasr",
    reasonCode: "asr_transcript_missing",
    message: "ASR 未生成 transcript",
    warnings: [],
  },
});

const validPartialStdout = JSON.stringify({
  success: true,
  transcript: {
    source: "asr",
    language: "zh-CN",
    cid: "123",
    segments: [
      { id: "s1", startSeconds: 0, endSeconds: 0, text: "整段识别结果" },
    ],
    complete: false,
  },
  acquisition: {
    status: "partial",
    source: "funasr",
    warnings: ["asr_vad_no_segments_detected: fallback"],
  },
});

describe("runAsrTranscript", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    // 默认让 Python 预检通过 (status=0), 具体测试可覆盖
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({
      pid: 1,
      output: [],
      stdout: Buffer.from("Python 3.12.0"),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    } as never);
    // 默认 cache miss, 具体测试可覆盖
    mockReadTranscriptCache.mockReset();
    mockReadTranscriptCache.mockReturnValue(null);
    mockWriteTranscriptCache.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cid 缺失 → asr_cid_required 失败, 不调 spawn, 不读 cache", async () => {
    const result = await runAsrTranscript({ bvid: "BV1nocid" });

    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("asr_cid_required");
    expect(result.acquisition.message).toContain("cid");
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockReadTranscriptCache).not.toHaveBeenCalled();
    expect(mockWriteTranscriptCache).not.toHaveBeenCalled();
  });

  it("spawn 成功且 Python 退出 0 且 stdout 是 success JSON", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validSuccessStdout,
      stderr: "[pipeline] 进度信息\n",
      exitCode: 0,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.source).toBe("funasr");
    expect(result.transcript.source).toBe("asr");
    expect(result.transcript.segments).toHaveLength(1);
    expect(result.transcript.segments[0]?.text).toBe("测试");
    expect(result.acquisition.itemCount).toBe(1);
  });

  it("Python 返回 partial transcript 时保留正文和不完整状态", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validPartialStdout,
      stderr: "",
      exitCode: 0,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("partial");
    expect(result.transcript.complete).toBe(false);
    expect(result.transcript.segments).toHaveLength(1);
    expect(result.acquisition.warnings).toContain("asr_vad_no_segments_detected: fallback");
    expect(mockWriteTranscriptCache).toHaveBeenCalledOnce();
  });

  it("Python 退出 0 但 stdout 是 failure JSON (ASR pipeline 自身失败)", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validFailureStdout,
      stderr: "",
      exitCode: 0,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("missing");
    expect(result.acquisition.reasonCode).toBe("asr_transcript_missing");
    expect(result.transcript.segments).toEqual([]); // 失败时返回空 transcript
  });

  it("Python 退出非 0 且 stdout 无 JSON → 包装 failed", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: "",
      stderr: "Traceback ... Python 崩溃",
      exitCode: 1,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("asr_pipeline_unparseable");
    expect(result.acquisition.message).toContain("Python 崩溃");
  });

  it("stdout 有非法 JSON (不符合 schema) → 包装 failed", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: JSON.stringify({ success: true, transcript: { invalid: "schema" } }),
      stderr: "",
      exitCode: 0,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("asr_pipeline_invalid_schema");
  });

  it("spawn 抛错 (Python 解释器不可用)", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: "",
      stderr: "",
      exitCode: -1,
      errorEvent: new Error("spawn <python> ENOENT"),
    }) as never);

    // spawn 抛错是编程错误, 应抛出异常 (让 get-subtitle.ts 的 try/catch 捕获)
    // 错误信息会含 PYTHON 路径 (默认是隔离 venv 的 python, 路径含 venv/bin/python)
    await expect(runAsrTranscript({ bvid: "BV1test", cid: "123" }))
      .rejects.toThrow(/spawn .*失败/);
  });

  it("超时后进程响应 SIGTERM 退出时取消后续 SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: Readable | null;
      stderr: Readable | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 43210;
    child.stdout = null;
    child.stderr = null;
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child as never);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);

    const previous = process.env.BILIBILI_SKILL_ASR_TIMEOUT_MS;
    process.env.BILIBILI_SKILL_ASR_TIMEOUT_MS = "10";
    try {
      const promise = runAsrTranscript({ bvid: "BV1test", cid: "123" });
      expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({
        detached: process.platform !== "win32",
      });

      await vi.advanceTimersByTimeAsync(10);
      if (process.platform === "win32") {
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(processKill).toHaveBeenCalledTimes(1);
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
      }

      // 模拟进程在宽限期内正常退出，此后不应再补发 SIGKILL。
      child.emit("close", -1);
      const result = await promise;
      await vi.advanceTimersByTimeAsync(5000);

      if (process.platform === "win32") {
        expect(child.kill).toHaveBeenCalledTimes(1);
      } else {
        expect(processKill).toHaveBeenCalledTimes(1);
      }
      expect(result.acquisition.status).toBe("failed");
      expect(result.acquisition.reasonCode).toBe("asr_timeout");
    } finally {
      processKill.mockRestore();
      if (previous === undefined) {
        delete process.env.BILIBILI_SKILL_ASR_TIMEOUT_MS;
      } else {
        process.env.BILIBILI_SKILL_ASR_TIMEOUT_MS = previous;
      }
    }
  });

  it("Python 不可用降级 → asr_python_not_found 失败, 不调 spawn", async () => {
    // 预检返回 ENOENT 错误
    mockSpawnSync.mockReturnValue({
      pid: 0,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: null,
      signal: null,
      error: Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }),
    } as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("asr_python_not_found");
    expect(result.acquisition.message).toContain("Python 解释器不可用");
    // 关键: 没调 spawn pipeline。缓存可以在环境预检前低成本读取。
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockReadTranscriptCache).toHaveBeenCalledOnce();
  });

  it("缓存命中 → 跳过 spawn, 直接返回, metadata.cacheHit=true", async () => {
    // mock 缓存有内容 (M6.2 schemaVersion=2 + cid 必填)
    mockReadTranscriptCache.mockReturnValue({
      schemaVersion: 2,
      cachedAt: new Date(Date.now() - 5000).toISOString(), // 5s 前
      bvid: "BV1test",
      cid: "123",
      transcript: {
        source: "asr",
        language: "zh-CN",
        cid: "123",
        segments: [
          { id: "s1", startSeconds: 0, endSeconds: 1, text: "缓存命中测试" },
        ],
        complete: true,
      },
      acquisition: {
        dataKind: "transcript",
        status: "success",
        source: "funasr",
        warnings: ["原始 warning"],
      },
      asrProvider: "funasr",
    });

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "123" });

    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.source).toBe("funasr");
    expect(result.transcript.segments[0]?.text).toBe("缓存命中测试");
    expect(result.acquisition.metadata?.cacheHit).toBe(true);
    expect(result.acquisition.metadata?.pipelinePhase).toBe("cache");
    // 关键: 命中时没调 spawn
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWriteTranscriptCache).not.toHaveBeenCalled();
    // warnings 应包含 cache_hit 标记
    expect(result.acquisition.warnings.some((w) => w.startsWith("cache_hit:"))).toBe(true);
  });

  it("缓存命中要求 cid 跟读 cache 时的 cid 一致 (mock 层不变, 调用方传错 cid 就 miss)", async () => {
    // 缓存里只存了 cid=123, 但调用方传 cid=456
    mockReadTranscriptCache.mockReturnValue(null); // 实际是 mock, 真会按 cacheKey 找, 不存在返回 null
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validSuccessStdout,
      stderr: "",
      exitCode: 0,
    }) as never);

    const result = await runAsrTranscript({ bvid: "BV1test", cid: "456" });
    // 应该走 spawn 而不是 cache hit
    expect(mockSpawn).toHaveBeenCalled();
    expect(result.acquisition.status).toBe("success");
  });

  it("miss + spawn 成功 → 写缓存 (必带 cid)", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validSuccessStdout,
      stderr: "",
      exitCode: 0,
    }) as never);

    await runAsrTranscript({ bvid: "BV1write", cid: "123" });

    expect(mockWriteTranscriptCache).toHaveBeenCalledTimes(1);
    // 关键 (): 写缓存时 bvid 和 cid 都必传
    const call = mockWriteTranscriptCache.mock.calls[0];
    expect(call?.[0]).toBe("BV1write");
    expect(call?.[1]).toBe("123");
  });

  it("miss + spawn 失败 → 不写缓存", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: "",
      stderr: "Traceback",
      exitCode: 1,
    }) as never);

    await runAsrTranscript({ bvid: "BV1fail", cid: "123" });

    expect(mockWriteTranscriptCache).not.toHaveBeenCalled();
  });

  it("miss + spawn 成功 + 写缓存失败 → 警告追加 cache_write_failed, 不阻塞结果", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({
      stdout: validSuccessStdout,
      stderr: "",
      exitCode: 0,
    }) as never);
    mockWriteTranscriptCache.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = await runAsrTranscript({ bvid: "BV1writefail", cid: "123" });

    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.warnings.some((w) => w.startsWith("cache_write_failed:"))).toBe(true);
  });
});
