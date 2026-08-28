/**
 * scripts/cli/commands/setup.ts: 准备 Skill Runtime 所需外部环境.
 *
 * 两种模式:
 * - --plan (默认): 输出 plan JSON, 不真执行
 * - --apply: 实际跑 (macOS brew / Linux apt 装 ffmpeg; 创建 venv + 装 pip 依赖)
 *
 * 设计原则 (跟 doc §十四 "Setup 四属性" 对齐):
 * - Idempotent: 重复执行不重复下载 (doctor 检查 already ready 跳过)
 * - Resumable: pip 与 ModelScope 缓存支持中断后继续
 * - Observable: stderr 流式输出每步进度
 * - Non-destructive: 默认不动系统 Python (隔离 venv); ffmpeg install 需要 sudo
 *
 * 模型和依赖版本来自随发布物交付的运行清单。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { dataPaths, runtimePaths } from "../../lib/paths.js";
import {
  ASR_PYTHON_MIN_VERSION,
  isAsrPythonSupported,
  parsePythonMajorMinor,
} from "../../lib/python-version.js";

const execFileAsync = promisify(execFile);

const SETUP_USAGE = `Usage: setup <media|asr|all> [--plan] [--apply]

Phases:
  media     安装 ffmpeg (供 frames Tool + ASR audio extraction)
  asr       创建 Python 隔离 venv + 装 funasr/torch/modelscope
  all       等价于 media + asr

Options:
  --plan     输出 plan JSON 后退出 (默认)
  --apply    真执行 (macOS brew / Linux apt 装 ffmpeg; venv + pip install)
  --json     (默认就是 JSON 输出)

ffmpeg 自动安装仅支持 brew 与 apt；其它平台会返回手动安装提示。
`;

export interface PlanItem {
  step: string;
  scope: "system" | "user" | "skill-data";
  description: string;
  requiresSudo: boolean;
  estimatedMB: number;
  estimatedSeconds: number;
  networkRequired: boolean;
}

export interface SetupPlan {
  capability: string;
  doctorSnapshot: {
    capabilities: Array<{
      capability: string;
      status: string;
      checks: Record<string, string>;
    }>;
  };
  steps: PlanItem[];
  totalMB: number;
  totalSeconds: number;
  notes: string[];
}

/** Apply 模式单步结果 */
export interface ApplyStepResult {
  step: string;
  status: "ok" | "failed" | "skipped";
  /** 人类可读原因 / 输出摘要 */
  detail: string;
  /** 估算耗时 (秒) */
  durationSeconds: number;
}

interface ApplyResult {
  capability: string;
  doctorBefore: SetupPlan["doctorSnapshot"];
  steps: ApplyStepResult[];
  doctorAfter: SetupPlan["doctorSnapshot"];
  overall: "ok" | "partial" | "failed";
  notes: string[];
}

export type PackageManager =
  | { kind: "brew" | "apt"; cmd: string }
  | { kind: "unknown"; hint: string };

function parseArgs(args: string[]): {
  phase: "media" | "asr" | "all";
  apply: boolean;
} {
  const phase = args[0];
  if (phase !== "media" && phase !== "asr" && phase !== "all") {
    process.stderr.write(SETUP_USAGE);
    process.exit(2);
  }
  let apply = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") {
      apply = true;
    } else if (a === "--plan") {
      apply = false;
    } else if (a === "--json") {
      // 默认 JSON
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(SETUP_USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown argument "${a}"\n`);
      process.stderr.write(SETUP_USAGE);
      process.exit(2);
    }
  }
  return { phase, apply };
}

export function buildMediaSteps(packageManager: PackageManager): PlanItem[] {
  if (packageManager.kind === "unknown") {
    return [{
      step: "手动准备 ffmpeg 与 ffprobe",
      scope: "system",
      description: packageManager.hint,
      requiresSudo: false,
      estimatedMB: 80,
      estimatedSeconds: 120,
      networkRequired: true,
    }];
  }
  return [
    {
      step: "检测包管理器 (brew / apt)",
      scope: "system",
      description: `已检测到 ${packageManager.kind}`,
      requiresSudo: false,
      estimatedMB: 0,
      estimatedSeconds: 2,
      networkRequired: false,
    },
    {
      step: "安装 ffmpeg",
      scope: "system",
      description: "macOS: brew install ffmpeg | Ubuntu/Debian: apt install ffmpeg",
      requiresSudo: packageManager.kind === "apt",
      estimatedMB: 80,
      estimatedSeconds: 60,
      networkRequired: true,
    },
    {
      step: "验证 ffmpeg 可执行",
      scope: "user",
      description: "ffmpeg -version",
      requiresSudo: false,
      estimatedMB: 0,
      estimatedSeconds: 2,
      networkRequired: false,
    },
    {
      step: "验证 ffprobe 可执行",
      scope: "user",
      description: "ffprobe -version",
      requiresSudo: false,
      estimatedMB: 0,
      estimatedSeconds: 2,
      networkRequired: false,
    },
  ];
}

function buildAsrSteps(): PlanItem[] {
  return [
    {
      step: "检测 Python 3",
      scope: "system",
      description: `PATH 找 python3 (要求 >= ${ASR_PYTHON_MIN_VERSION})`,
      requiresSudo: false,
      estimatedMB: 0,
      estimatedSeconds: 2,
      networkRequired: false,
    },
    {
      step: "创建 Skill 专属 Python 隔离 venv",
      scope: "skill-data",
      description: `在 ${dataPaths.asrVenv()} 创建 venv`,
      requiresSudo: false,
      estimatedMB: 50,
      estimatedSeconds: 30,
      networkRequired: false,
    },
    {
      step: "在 venv 里装锁版本依赖 (funasr / torch / modelscope)",
      scope: "skill-data",
      description: `pip install -r ${runtimePaths.requirementsLock()}`,
      requiresSudo: false,
      estimatedMB: 1500,
      estimatedSeconds: 300,
      networkRequired: true,
    },
    {
      step: "下载并核验固定版本 ASR 模型",
      scope: "skill-data",
      description: `模型写入 ${dataPaths.asrModels()}，状态写入 ${dataPaths.stateFile()}`,
      requiresSudo: false,
      estimatedMB: 1000,
      estimatedSeconds: 600,
      networkRequired: true,
    },
  ];
}

function sumSteps(steps: PlanItem[]): {
  totalMB: number;
  totalSeconds: number;
} {
  return steps.reduce(
    (acc, s) => ({
      totalMB: acc.totalMB + s.estimatedMB,
      totalSeconds: acc.totalSeconds + s.estimatedSeconds,
    }),
    { totalMB: 0, totalSeconds: 0 },
  );
}

async function snapshotDoctor(phase: "media" | "asr" | "all"): Promise<SetupPlan["doctorSnapshot"]> {
  const { checkMedia, checkAsr } = await import("./doctor.js");
  const caps = [];
  if (phase === "media" || phase === "asr" || phase === "all") caps.push(await checkMedia());
  if (phase === "asr" || phase === "all") caps.push(await checkAsr());
  return {
    capabilities: caps.map((c) => ({
      capability: c.capability,
      status: c.status,
      checks: c.checks,
    })),
  };
}

// === Apply 实现 ===

/** 检测系统包管理器命令. macOS / Linux(Ubuntu/Debian) / 其它. */
async function detectPackageManager(): Promise<PackageManager> {
  try {
    await execFileAsync("brew", ["--version"], { timeout: 5000 });
    return { kind: "brew", cmd: "brew" };
  } catch {
    // not macOS or no brew
  }
  try {
    await execFileAsync("apt", ["--version"], { timeout: 5000 });
    return { kind: "apt", cmd: "apt" };
  } catch {
    // not Debian/Ubuntu or no apt
  }
  return {
    kind: "unknown",
    hint:
      "未检测到 brew (macOS) 或 apt (Ubuntu/Debian). 其它 OS (Windows / CentOS / Fedora) 留 V1.1.",
  };
}

/** 流式执行命令, stderr 透传给用户, 完成后返回结果. */
function runCommandStreaming(
  cmd: string,
  args: string[],
  options: { label: string; timeoutMs: number; useSudo: boolean },
): Promise<{ ok: boolean; detail: string; durationSeconds: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const realArgs = options.useSudo ? ["-n", cmd, ...args] : args;
    const realCmd = options.useSudo ? "sudo" : cmd;
    process.stderr.write(`[setup] ${options.label}: ${realCmd} ${realArgs.join(" ")}\n`);
    const child = spawn(realCmd, realArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(`  ${chunk.toString("utf-8").replace(/\n(?!$)/g, "\n  ").trimEnd()}\n`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`  ${chunk.toString("utf-8").replace(/\n(?!$)/g, "\n  ").trimEnd()}\n`);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const duration = Math.round((Date.now() - start) / 1000);
      if (code === 0) {
        resolve({ ok: true, detail: `${realCmd} 退出 0`, durationSeconds: duration });
      } else {
        resolve({
          ok: false,
          detail: `${realCmd} 退出码 ${code}${options.useSudo ? " (sudo -n 失败可能因为需要密码, 改用 sudo <cmd> 手动跑)" : ""}`,
          durationSeconds: duration,
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        detail: `spawn ${realCmd} 失败: ${err.message}`,
        durationSeconds: Math.round((Date.now() - start) / 1000),
      });
    });
  });
}

/** Apply: media 阶段 (装 ffmpeg) */
async function applyMedia(doctorBefore: SetupPlan["doctorSnapshot"]): Promise<ApplyStepResult[]> {
  const results: ApplyStepResult[] = [];

  // 两个命令都已由 doctor 验证时，不要求机器必须具有 brew / apt。
  if (isMediaReady(doctorBefore)) {
    return [{
      step: "准备 ffmpeg 与 ffprobe",
      status: "skipped",
      detail: "doctor 检查 media 已 ok，无需检测包管理器或重复安装",
      durationSeconds: 0,
    }];
  }

  // Step 1: 检测包管理器
  const pm = await detectPackageManager();
  if (pm.kind === "unknown") {
    results.push({
      step: "检测包管理器",
      status: "failed",
      detail: pm.hint,
      durationSeconds: 0,
    });
    return results; // 没包管理器就停了
  }
  results.push({
    step: "检测包管理器",
    status: "ok",
    detail: `检测到 ${pm.kind}`,
    durationSeconds: 1,
  });

  // ffmpeg 或 ffprobe 任一缺失时，重新安装同一系统包以恢复完整 media 能力。
  const installCmd = pm.kind === "brew" ? ["install", "ffmpeg"] : ["install", "-y", "ffmpeg"];
  const res = await runCommandStreaming(pm.cmd, installCmd, {
    label: "install ffmpeg",
    timeoutMs: 5 * 60_000,
    useSudo: pm.kind === "apt",
  });
  results.push({
    step: "安装 ffmpeg",
    status: res.ok ? "ok" : "failed",
    detail: res.detail,
    durationSeconds: res.durationSeconds,
  });
  if (!res.ok) return results;

  // Step 3: 验证
  const verify = await runCommandStreaming("ffmpeg", ["-version"], {
    label: "verify ffmpeg",
    timeoutMs: 5_000,
    useSudo: false,
  });
  results.push({
    step: "验证 ffmpeg",
    status: verify.ok ? "ok" : "failed",
    detail: verify.detail,
    durationSeconds: verify.durationSeconds,
  });

  const verifyProbe = await runCommandStreaming("ffprobe", ["-version"], {
    label: "verify ffprobe",
    timeoutMs: 5_000,
    useSudo: false,
  });
  results.push({
    step: "验证 ffprobe",
    status: verifyProbe.ok ? "ok" : "failed",
    detail: verifyProbe.detail,
    durationSeconds: verifyProbe.durationSeconds,
  });

  return results;
}

/** media 能力要求 ffmpeg 与 ffprobe 同时可用。 */
export function isMediaReady(snapshot: SetupPlan["doctorSnapshot"]): boolean {
  const media = snapshot.capabilities.find((item) => item.capability === "media");
  return media?.checks.ffmpeg === "ok" && media.checks.ffprobe === "ok";
}

/** 检测系统 Python 3 */
async function findSystemPython(): Promise<
  { kind: "python3"; cmd: string; version: string } | { kind: "missing"; hint: string }
> {
  const cmd = process.platform === "win32" ? "py" : "python3";
  try {
    const { stdout } = await execFileAsync(cmd, ["--version"], { timeout: 5000, windowsHide: true });
    const parsed = parsePythonMajorMinor(stdout);
    if (!parsed) return { kind: "missing", hint: `无法解析 Python 版本: ${stdout}` };
    if (!isAsrPythonSupported(stdout)) {
      return {
        kind: "missing",
        hint: `Python ${parsed.version} 太老, 需要 ${ASR_PYTHON_MIN_VERSION}+`,
      };
    }
    return { kind: "python3", cmd, version: parsed.version };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        kind: "missing",
        hint: "未找到 python3 命令. macOS: brew install python; Ubuntu: apt install python3",
      };
    }
    return { kind: "missing", hint: `python3 --version 失败: ${err.message}` };
  }
}

/** Apply: asr 阶段 (venv + pip install) */
async function applyAsr(doctorBefore: SetupPlan["doctorSnapshot"]): Promise<ApplyStepResult[]> {
  const results: ApplyStepResult[] = [];
  const asrBefore = doctorBefore.capabilities.find((c) => c.capability === "asr");
  const venvOk = asrBefore?.checks.isolatedVenv === "ok";
  const venvPath = dataPaths.asrVenv();
  const venvPython = dataPaths.asrVenvPython();

  // Step 1: 检测 python3
  const py = await findSystemPython();
  if (py.kind === "missing") {
    results.push({
      step: "检测 Python 3",
      status: "failed",
      detail: py.hint,
      durationSeconds: 1,
    });
    return results;
  }
  results.push({
    step: "检测 Python 3",
    status: "ok",
    detail: `python3 ${py.version}`,
    durationSeconds: 1,
  });

  // Step 2: 创建 venv (Idempotent: 已存在跳过)
  if (venvOk || existsSync(venvPython)) {
    results.push({
      step: "创建 Python 隔离 venv",
      status: "skipped",
      detail: `venv 已存在 (${venvPath})`,
      durationSeconds: 0,
    });
  } else {
    const res = await runCommandStreaming(py.cmd, ["-m", "venv", venvPath], {
      label: "create venv",
      timeoutMs: 60_000,
      useSudo: false,
    });
    results.push({
      step: "创建 Python 隔离 venv",
      status: res.ok ? "ok" : "failed",
      detail: res.detail,
      durationSeconds: res.durationSeconds,
    });
    if (!res.ok) return results;
  }

  // Step 3: 装 requirements.lock
  const reqLock = runtimePaths.requirementsLock();
  if (!existsSync(reqLock)) {
    results.push({
      step: "装锁版本依赖",
      status: "failed",
      detail: `requirements.lock 不存在: ${reqLock}`,
      durationSeconds: 0,
    });
    return results;
  }
  const pipRes = await runCommandStreaming(
    venvPython,
    ["-m", "pip", "install", "-r", reqLock],
    {
      label: "pip install requirements.lock",
      timeoutMs: 10 * 60_000, // 10 分钟
      useSudo: false,
    },
  );
  results.push({
    step: "装锁版本依赖",
    status: pipRes.ok ? "ok" : "failed",
    detail: pipRes.detail,
    durationSeconds: pipRes.durationSeconds,
  });
  if (!pipRes.ok) return results;

  // Step 4: 验证 funasr import
  const importRes = await runCommandStreaming(venvPython, [
    "-c",
    "import funasr, torchaudio; from funasr import AutoModel; print(funasr.__version__)",
  ], {
    label: "verify funasr",
    timeoutMs: 30_000,
    useSudo: false,
  });
  results.push({
    step: "验证 funasr import",
    status: importRes.ok ? "ok" : "failed",
    detail: importRes.detail,
    durationSeconds: importRes.durationSeconds,
  });
  if (!importRes.ok) return results;

  const prepareRes = await runCommandStreaming(
    venvPython,
    [
      runtimePaths.prepareModels(),
      "--manifest", runtimePaths.manifest(),
      "--models-dir", dataPaths.asrModels(),
      "--state-file", dataPaths.stateFile(),
    ],
    { label: "prepare pinned ASR models", timeoutMs: 30 * 60_000, useSudo: false },
  );
  results.push({
    step: "准备固定版本 ASR 模型",
    status: prepareRes.ok ? "ok" : "failed",
    detail: prepareRes.detail,
    durationSeconds: prepareRes.durationSeconds,
  });

  return results;
}

async function runPlanMode(phase: "media" | "asr" | "all"): Promise<number> {
  const doctorSnapshot = await snapshotDoctor(phase);

  const steps: PlanItem[] = [];
  const mediaReady = doctorSnapshot.capabilities.find((item) => item.capability === "media")?.status === "ok";
  const asrReady = doctorSnapshot.capabilities.find((item) => item.capability === "asr")?.status === "ok";
  if ((phase === "media" || phase === "asr" || phase === "all") && !mediaReady) {
    steps.push(...buildMediaSteps(await detectPackageManager()));
  }
  if ((phase === "asr" || phase === "all") && !asrReady) steps.push(...buildAsrSteps());
  const { totalMB, totalSeconds } = sumSteps(steps);

  const plan: SetupPlan = {
    capability: phase,
    doctorSnapshot,
    steps,
    totalMB,
    totalSeconds,
    notes: [
      "Plan 模式: 仅输出要做的事, 不真执行",
      "Apply 模式: `setup <phase> --apply` 真跑；ffmpeg 自动安装仅支持 brew / apt，其它平台按计划提示手动准备",
      "Tool 永远不自动 setup, 只会返回 setupHint 引导 Agent 调本命令",
      "模型只会在 --apply 且用户已明确授权后下载；Tool 调用不会隐式下载",
      ...(steps.length === 0 ? ["所选能力已经可用，无需修改环境"] : []),
    ],
  };

  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  return 0;
}

async function runApplyMode(phase: "media" | "asr" | "all"): Promise<number> {
  const doctorBefore = await snapshotDoctor(phase);

  let stepResults: ApplyStepResult[] = [];
  if (phase === "media" || phase === "asr" || phase === "all") {
    stepResults = stepResults.concat(await applyMedia(doctorBefore));
  }
  if (phase === "asr" || phase === "all") {
    stepResults = stepResults.concat(await applyAsr(doctorBefore));
  }

  const doctorAfter = await snapshotDoctor(phase);
  const overall = determineSetupOverall(phase, stepResults, doctorAfter);

  const result: ApplyResult = {
    capability: phase,
    doctorBefore,
    steps: stepResults,
    doctorAfter,
    overall,
    notes: [
      "Apply 模式: 真执行了部分步骤, 失败步骤给出原因",
      "运行清单版本未变化时复用现有 venv 和模型；关键文件仍由 doctor 实际核验",
    ],
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return overall === "ok" ? 0 : 1;
}

/** 安装步骤退出 0 不代表能力可用；最终状态必须以 doctorAfter 为准。 */
export function determineSetupOverall(
  phase: "media" | "asr" | "all",
  steps: ApplyStepResult[],
  doctorAfter: SetupPlan["doctorSnapshot"],
): "ok" | "partial" | "failed" {
  const required = phase === "media" ? ["media"] : ["media", "asr"];
  const requiredReady = required.every((capability) =>
    doctorAfter.capabilities.some((item) => item.capability === capability && item.status === "ok"),
  );
  const hasFailedStep = steps.some((step) => step.status === "failed");
  if (requiredReady && !hasFailedStep) return "ok";

  const hasUsableCapability = doctorAfter.capabilities.some((item) => item.status === "ok");
  const madeProgress = steps.some((step) => step.status === "ok" || step.status === "skipped");
  return hasUsableCapability || madeProgress ? "partial" : "failed";
}

export async function runSetupCommand(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (opts.apply) {
    return runApplyMode(opts.phase);
  }
  return runPlanMode(opts.phase);
}
