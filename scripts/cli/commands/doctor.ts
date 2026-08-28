/** 环境诊断：只读检查，绝不安装或下载。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { dataPaths } from "../../lib/paths.js";
import { inspectAsrRuntime } from "../../lib/asr-runtime.js";
import { ASR_PYTHON_MIN_VERSION, isAsrPythonSupported } from "../../lib/python-version.js";

const execFileAsync = promisify(execFile);
type CheckState = "ok" | "missing" | "error";

export interface CapabilityCheck {
  capability: string;
  checks: Record<string, CheckState>;
  status: "ok" | "degraded" | "unavailable";
  details: Record<string, string>;
}

const DOCTOR_USAGE = `Usage: doctor [--json] [--capability <core|media|asr>]\n`;

async function commandCheck(command: string, args: string[]): Promise<{ state: CheckState; detail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15_000, windowsHide: true });
    return { state: "ok", detail: (stdout || stderr).trim().split("\n")[0] ?? "ok" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { state: err.code === "ENOENT" ? "missing" : "error", detail: err.message };
  }
}

export async function checkCore(): Promise<CapabilityCheck> {
  const major = Number(process.versions.node.split(".")[0]);
  const checks: Record<string, CheckState> = { node: major >= 20 ? "ok" : "error" };
  const details: Record<string, string> = { node: `Node ${process.versions.node}; 需要 >=20` };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch("https://api.bilibili.com/", { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    checks.bilibiliNetwork = response.status < 500 ? "ok" : "error";
    details.bilibiliNetwork = `HTTP ${response.status}`;
  } catch (error) {
    checks.bilibiliNetwork = "error";
    details.bilibiliNetwork = (error as Error).message;
  }
  return { capability: "core", checks, status: Object.values(checks).every((value) => value === "ok") ? "ok" : "unavailable", details };
}

export async function checkMedia(): Promise<CapabilityCheck> {
  const ffmpeg = await commandCheck("ffmpeg", ["-version"]);
  const ffprobe = await commandCheck("ffprobe", ["-version"]);
  const checks = { ffmpeg: ffmpeg.state, ffprobe: ffprobe.state };
  return { capability: "media", checks, status: Object.values(checks).every((value) => value === "ok") ? "ok" : "unavailable", details: { ffmpeg: ffmpeg.detail, ffprobe: ffprobe.detail } };
}

export async function checkAsr(): Promise<CapabilityCheck> {
  const systemCommand = process.platform === "win32" ? "py" : "python3";
  const python = await commandCheck(systemCommand, ["--version"]);
  if (python.state === "ok" && !isAsrPythonSupported(python.detail)) python.state = "error";
  const media = await checkMedia();
  const runtime = inspectAsrRuntime();
  const venvImport = runtime.checks.isolatedVenv === "ok"
    ? await commandCheck(dataPaths.asrVenvPython(), [
        "-c",
        "import funasr, modelscope, torch, torchaudio; from funasr import AutoModel; print(funasr.__version__)",
      ])
    : { state: "missing" as const, detail: "隔离环境尚未创建" };
  const checks: Record<string, CheckState> = {
    python: python.state,
    ffmpeg: media.checks.ffmpeg ?? "missing",
    ffprobe: media.checks.ffprobe ?? "missing",
    ...runtime.checks,
    funasrImport: venvImport.state,
  };
  return {
    capability: "asr",
    checks,
    status: Object.values(checks).every((value) => value === "ok") ? "ok" : "unavailable",
    details: {
      python: `${python.detail}; 需要 >=${ASR_PYTHON_MIN_VERSION}`,
      funasrImport: venvImport.detail,
      ...runtime.details,
    },
  };
}

function parseArgs(args: string[]): { json: boolean; capability: "all" | "core" | "media" | "asr" } {
  let json = false;
  let capability: "all" | "core" | "media" | "asr" = "all";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--capability") {
      const value = args[++index];
      if (value !== "core" && value !== "media" && value !== "asr") throw new Error("--capability 必须是 core、media 或 asr");
      capability = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(DOCTOR_USAGE);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return { json, capability };
}

export async function runDoctorCommand(args: string[]): Promise<number> {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${DOCTOR_USAGE}`);
    return 2;
  }
  const results: CapabilityCheck[] = [];
  if (options.capability === "all" || options.capability === "core") results.push(await checkCore());
  if (options.capability === "all" || options.capability === "media") results.push(await checkMedia());
  if (options.capability === "all" || options.capability === "asr") results.push(await checkAsr());
  if (options.json) {
    process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, platform: os.platform(), arch: os.arch(), capabilities: results }, null, 2) + "\n");
  } else {
    for (const result of results) {
      process.stdout.write(`[${result.capability.toUpperCase()}] ${result.status}\n`);
      for (const [name, state] of Object.entries(result.checks)) process.stdout.write(`  ${state === "ok" ? "✓" : "✗"} ${name}: ${state}\n`);
    }
  }
  return 0;
}
