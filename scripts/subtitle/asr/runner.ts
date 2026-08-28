/**
 * scripts/subtitle/asr/runner.ts: TypeScript 包装 Level 3 ASR 全链路.
 *
 * 通过 child_process.spawn 调用 runtime/python/pipeline.py,
 * 解析 stdout 的结构化 JSON, 返回与 Level 1 同 schema 的 Transcript + AcquisitionRecord.
 *
 * 关键设计:
 * - 不引入 IPC/HTTP 复杂度, 单层 spawn 即可
 * - Python 失败 → 返回结构化 AcquisitionRecord (status="failed"), 不抛异常
 *   (D10: 数据源失败时让 Agent 获得结构化失败信息)
 * - 超时: 默认 10 分钟, 可通过 `BILIBILI_SKILL_ASR_TIMEOUT_MS` 环境变量覆盖。
 *   语音识别耗时取决于视频长度与机器性能，外层调用超时必须比这里更长。
 * - Python 默认用隔离 venv (Data Home/runtime/python/venv/bin/python),
 *   BILIBILI_SKILL_PYTHON 覆盖 (单测 / CI 用系统 python)
 * - 缓存路径: 通过 paths.ts 的 cachePaths 解析 (BILIBILI_SKILL_CACHE_DIR 覆盖)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  AcquisitionRecordSchema,
  type AcquisitionRecord,
} from "../../models/index.js";
import { TranscriptSchema, type Transcript } from "../model.js";
import { readTranscriptCache, writeTranscriptCache } from "./cache.js";
import { dataPaths, cachePaths, runtimePaths } from "../../lib/paths.js";
import { inspectAsrRuntime } from "../../lib/asr-runtime.js";

/** ASR 全链路 Python 入口相对 skill root 的路径. */
const PIPELINE_SCRIPT = runtimePaths.pipeline();

/** Python 解释器, 默认隔离 venv; env BILIBILI_SKILL_PYTHON 覆盖. */
const PYTHON = process.env.BILIBILI_SKILL_PYTHON ?? dataPaths.asrVenvPython();

/**
 * 缓存根目录. 通过 `BILIBILI_SKILL_CACHE_DIR` 环境变量覆盖 (单测用临时目录,
 * 避免污染真实 ~/.cache/bilibili-skill/).
 * 注: 这里只读环境变量, 不 import cache.ts 的 const — cache.ts 内部同样会读
 * 这个变量, 但 env 读取顺序由 Node.js 启动时确定, 需在 import 前设置.
 */
const CACHE_DIR_OVERRIDE = process.env.BILIBILI_SKILL_CACHE_DIR;

/** 单次 ASR 调用的硬超时默认值 (ms)，兼顾二十分钟左右视频在普通机器上的转写。 */
const DEFAULT_ASR_TIMEOUT_MS = 10 * 60_000;

/**
 * 解析 ASR 超时 (ms). 优先级: `BILIBILI_SKILL_ASR_TIMEOUT_MS` 环境变量 > 默认值.
 * 非法值回落到默认值, 避免 spawn 后因为错值无法 kill.
 */
function getAsrTimeoutMs(): number {
  const raw = process.env.BILIBILI_SKILL_ASR_TIMEOUT_MS;
  if (!raw) return DEFAULT_ASR_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ASR_TIMEOUT_MS;
  return parsed;
}

/** ASR Pipeline 返回的 JSON Schema. */
const AsrPipelineOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    transcript: TranscriptSchema,
    acquisition: z.object({
      /** 整段回退或过滤过短语音时，保留可用但不完整的 Transcript。 */
      status: z.enum(["success", "partial"]),
      source: z.literal("funasr"),
      warnings: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    success: z.literal(false),
    transcript: z.null(),
    acquisition: z.object({
      status: z.enum(["missing", "failed"]),
      source: z.literal("funasr"),
      reasonCode: z.string(),
      message: z.string(),
      warnings: z.array(z.string()).default([]),
    }),
  }),
]);

export type AsrPipelineOutput = z.infer<typeof AsrPipelineOutputSchema>;

/** ASR 入口参数. */
export interface RunAsrTranscriptInput {
  /** B 站 BV 号, 例如 "BV1ZEbS65E34". */
  bvid: string;
  /** B 站分P cid, 可选. 注入到最终 Transcript.cid, 便于回查. */
  cid?: string;
}

/** ASR 入口结果. */
export interface RunAsrTranscriptResult {
  /** Level 3 ASR 转写得到的 Transcript (同 M1 schema). */
  transcript: Transcript;
  /** 本次 ASR 采集的结构化记录, 供 Agent 判断能力缺口. */
  acquisition: AcquisitionRecord;
}

/**
 * 调用 Level 3 ASR 全链路, 返回 Transcript + AcquisitionRecord.
 *
 * 不抛业务异常: 任何失败 (Python 不可用, 解析失败, 超时, ASR 失败)
 * 都通过 `acquisition.status = "failed"` + `acquisition.reasonCode` 表达.
 *
 * 真正抛出的只有: 编码 bug (参数 schema 不匹配, 项目根路径错误).
 */
export async function runAsrTranscript(
  input: RunAsrTranscriptInput,
): Promise<RunAsrTranscriptResult> {
  const params = RunAsrTranscriptInputSchema.parse(input);
  const startedAt = new Date().toISOString();

  // 阶段 2: 缓存命中跳过 spawn, 直接返回. miss 才跑全链路.
  // cache key 强制含 cid, 避免跨分P 复用错误数据.
  // cid 缺失时按 miss 处理, 走全链路 (Python pipeline 也会走 B1 路径, 但至少不会读到错的 cache).
  if (!params.cid) {
    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "transcript",
      status: "failed",
      source: "funasr",
      requestedAt: startedAt,
      completedAt: new Date().toISOString(),
      reasonCode: "asr_cid_required",
      message: "ASR 工具必须接收 cid 才能保证 Evidence Identity ()",
      metadata: {
        bvId: params.bvid,
        pipelinePhase: "cache_miss",
      },
    });
    return {
      transcript: TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        segments: [],
        complete: false,
      }),
      acquisition,
    };
  }
  const cached = readTranscriptCache(params.bvid, params.cid, CACHE_DIR_OVERRIDE
    ? join(CACHE_DIR_OVERRIDE, "transcript")
    : undefined);
  if (cached) {
    const ageMs = Date.now() - Date.parse(cached.cachedAt);
    const transcript = TranscriptSchema.parse(cached.transcript);
    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "transcript",
      // 透传 cache 里的 status (可能是 partial, 不强制 success)
      // cache hit 不会改变 ASR Pipeline 当初跑出来的结果可信度
      status: cached.acquisition.status,
      source: "funasr",
      requestedAt: startedAt,
      completedAt: new Date().toISOString(),
      itemCount: transcript.segments.length,
      warnings: [
        ...cached.acquisition.warnings,
        `cache_hit: age=${Math.round(ageMs / 1000)}s`,
      ],
      metadata: {
        bvId: params.bvid,
        pipelinePhase: "cache",
        cacheHit: true,
        cachedAt: cached.cachedAt,
        cacheAgeMs: ageMs,
        asrProvider: cached.asrProvider,
      },
    });
    return { transcript, acquisition };
  }

  // 只有缓存未命中时才需要本地 ASR 环境。
  const pyCheck = spawnSync(PYTHON, ["--version"], { stdio: "ignore" });
  if (pyCheck.error || pyCheck.status !== 0) {
    const reason = pyCheck.error?.message ?? `exit ${pyCheck.status}`;
    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "transcript", status: "failed", source: "funasr",
      requestedAt: startedAt, completedAt: new Date().toISOString(),
      reasonCode: "asr_python_not_found",
      message: `Python 解释器不可用 (${PYTHON}): ${reason}`,
      metadata: { bvId: params.bvid, pipelinePhase: "python_check" },
    });
    return {
      transcript: TranscriptSchema.parse({ source: "asr", language: "zh-CN", segments: [], complete: false }),
      acquisition,
    };
  }

  const runtime = inspectAsrRuntime();
  if (!runtime.ready || !runtime.state) {
    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "transcript", status: "failed", source: "funasr",
      requestedAt: startedAt, completedAt: new Date().toISOString(),
      reasonCode: "asr_runtime_unavailable",
      message: "ASR 隔离环境或固定版本模型尚未准备完成，请先执行 setup asr。",
      metadata: { bvId: params.bvid, pipelinePhase: "runtime_check", checks: runtime.checks },
    });
    return {
      transcript: TranscriptSchema.parse({ source: "asr", language: "zh-CN", segments: [], complete: false }),
      acquisition,
    };
  }

  // miss: 跑全链路
  const result = await runPipelineWithTimeout(params.bvid, params.cid, runtime.state);

  if (!result.success) {
    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "transcript",
      status: result.acquisition.status,
      source: "funasr",
      requestedAt: startedAt,
      completedAt: new Date().toISOString(),
      reasonCode: result.acquisition.reasonCode,
      message: result.acquisition.message,
      warnings: result.acquisition.warnings,
      metadata: {
        bvId: params.bvid,
        pipelinePhase: "asr",
      },
    });
    // 失败时不返回 transcript, 调用方应检查 acquisition.status
    return {
      transcript: TranscriptSchema.parse({
        source: "asr",
        language: "zh-CN",
        segments: [],
        complete: false,
      }),
      acquisition,
    };
  }

  // 成功: 把 pipeline 输出的 transcript source 强制设为 "asr" (兼容 Level 1 用 "official"/"official_ai")
  // status 透传 pipeline 的判断 (fallback_segment 时是 partial)
  const transcript = TranscriptSchema.parse({
    ...result.transcript,
    source: "asr",
  });

  const acquisition = AcquisitionRecordSchema.parse({
    dataKind: "transcript",
    status: result.acquisition.status,  // 透传 pipeline 状态 (success / partial / missing)
    source: "funasr",
    requestedAt: startedAt,
    completedAt: new Date().toISOString(),
    itemCount: transcript.segments.length,
    warnings: result.acquisition.warnings,
    metadata: {
      bvId: params.bvid,
      pipelinePhase: "asr",
    },
  });

  // 阶段 2: 成功后写缓存, 供下次直接命中
  // 写缓存时强制带 cid, 避免 P1 ASR 结果被 P2 当 cache 命中.
  try {
    if (params.cid) {
      writeTranscriptCache(params.bvid, params.cid, transcript, acquisition, CACHE_DIR_OVERRIDE
        ? join(CACHE_DIR_OVERRIDE, "transcript")
        : undefined);
    }
  } catch (e) {
    // 写失败不阻塞本次结果, 只在 warnings 里追加
    acquisition.warnings.push(`cache_write_failed: ${(e as Error).message}`);
  }

  return { transcript, acquisition };
}

const RunAsrTranscriptInputSchema = z.object({
  bvid: z.string().min(1),
  cid: z.string().min(1).optional(),
});

interface SpawnResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** spawn pipeline.py + 解析 stdout JSON, 包装超时和错误. */
function runPipelineWithTimeout(
  bvid: string,
  cid: string | undefined,
  runtimeState: NonNullable<ReturnType<typeof inspectAsrRuntime>["state"]>,
): Promise<AsrPipelineOutput> {
  return new Promise((resolveOuter, rejectOuter) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const workDir = cachePaths.asrWork();
    mkdirSync(workDir, { recursive: true });
    // Unix 下创建独立进程组，超时时才能同时终止 pipeline.py 及其语音识别子进程。
    // 否则只杀父进程，真正占用算力的子进程仍会在后台继续运行。
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(
      PYTHON,
      [PIPELINE_SCRIPT, bvid, ...(cid ? [cid] : [])],
      {
        cwd: workDir,
        detached: useProcessGroup,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          BILIBILI_SKILL_VAD_MODEL_DIR: runtimeState.models.fsmnVad.path,
          BILIBILI_SKILL_SENSEVOICE_MODEL_DIR: runtimeState.models.senseVoice.path,
        },
      },
    );

    const terminatePipeline = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 进程组可能已经退出，继续尝试终止直接子进程。
        }
      }
      child.kill(signal);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminatePipeline("SIGTERM");
      // 5s 宽限期, 强杀
      forceKillTimer = setTimeout(() => terminatePipeline("SIGKILL"), 5000);
    }, getAsrTimeoutMs());

    const clearTerminationTimers = (): void => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTerminationTimers();
      rejectOuter(
        new Error(
          `spawn ${PYTHON} 失败: ${err.message} (Python 解释器是否可用?)`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTerminationTimers();

      const spawnResult: SpawnResult = {
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      };
      resolveOuter(parsePipelineOutput(spawnResult, bvid));
    });
  });
}

/** 把 spawn 结果解析成结构化 AsrPipelineOutput. */
function parsePipelineOutput(
  spawnResult: SpawnResult,
  bvid: string,
): AsrPipelineOutput {
  // 1) 超时
  if (spawnResult.timedOut) {
    return {
      success: false,
      transcript: null,
      acquisition: {
        status: "failed",
        source: "funasr",
        reasonCode: "asr_timeout",
        message: `ASR 流水线超时 (${getAsrTimeoutMs() / 1000}s)`,
        warnings: [],
      },
    };
  }

  // 2) 非 0 exit code 且 stdout 没 JSON, 说明 Python 早期失败
  const stdoutJson = extractJson(spawnResult.stdout);
  if (!stdoutJson) {
    return {
      success: false,
      transcript: null,
      acquisition: {
        status: "failed",
        source: "funasr",
        reasonCode: "asr_pipeline_unparseable",
        message: `ASR 流水线未输出 JSON (exit ${spawnResult.exitCode}). stderr: ${spawnResult.stderr.slice(-500)}`,
        warnings: [],
      },
    };
  }

  // 3) 解析 JSON, 验证 schema
  let parsed: AsrPipelineOutput;
  try {
    parsed = AsrPipelineOutputSchema.parse(JSON.parse(stdoutJson));
  } catch (e) {
    return {
      success: false,
      transcript: null,
      acquisition: {
        status: "failed",
        source: "funasr",
        reasonCode: "asr_pipeline_invalid_schema",
        message: `ASR 流水线 JSON 不符合 schema: ${(e as Error).message}. JSON: ${stdoutJson.slice(0, 300)}`,
        warnings: [],
      },
    };
  }

  return parsed;
}

/** 从混合输出 (进度 stderr 可能混入 stdout) 中提取最后一行 JSON. */
function extractJson(stdout: string): string | null {
  // 从末尾往前找第一个以 { 开头且以 } 结尾的连续 JSON
  // (Python 输出 JSON 后可能有 stderr 渗透, 但 stdout 一定是最后 print 的 JSON)
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // 简单方法: 找最后一行非空内容
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1];
  if (last && last.startsWith("{") && last.endsWith("}")) {
    return last;
  }
  return null;
}
