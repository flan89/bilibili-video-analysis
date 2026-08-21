import { existsSync, readFileSync } from "node:fs";
import { dataPaths, runtimePaths } from "./paths.js";

export interface AsrRuntimeManifest {
  runtimeManifestVersion: number;
  asrEnvironmentVersion: number;
  pythonMin: string;
  models: Array<{ key: "fsmnVad" | "senseVoice"; id: string; revision: string }>;
}

export interface AsrRuntimeState {
  runtimeManifestVersion: number;
  asrEnvironmentVersion: number;
  preparedAt: string;
  pythonVersion: string;
  models: Record<"fsmnVad" | "senseVoice", { id: string; revision: string; path: string }>;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readAsrManifest(file = runtimePaths.manifest()): AsrRuntimeManifest | undefined {
  return readJson<AsrRuntimeManifest>(file);
}

export function readAsrRuntimeState(file = dataPaths.stateFile()): AsrRuntimeState | undefined {
  return readJson<AsrRuntimeState>(file);
}

export interface InspectAsrRuntimeOptions {
  /** 测试或嵌入场景可覆盖；正式运行默认读取发布物中的清单。 */
  manifestFile?: string;
  /** 运行状态文件；正式运行默认位于 Data Home。 */
  stateFile?: string;
  /** 隔离环境 Python 路径。 */
  venvPython?: string;
  /** 模型数据根目录，仅用于诊断输出。 */
  modelsDir?: string;
}

/** 状态文件只用于定位；版本和关键文件仍逐项核验。 */
export function inspectAsrRuntime(options: InspectAsrRuntimeOptions = {}): {
  ready: boolean;
  checks: Record<string, "ok" | "missing" | "error">;
  details: Record<string, string>;
  state?: AsrRuntimeState;
} {
  const manifestFile = options.manifestFile ?? runtimePaths.manifest();
  const stateFile = options.stateFile ?? dataPaths.stateFile();
  const venvPython = options.venvPython ?? dataPaths.asrVenvPython();
  const modelsDir = options.modelsDir ?? dataPaths.asrModels();
  const manifest = readAsrManifest(manifestFile);
  const state = readAsrRuntimeState(stateFile);
  const modelVersionsMatch = manifest && state
    ? manifest.models.every((expected) => {
        const actual = state.models?.[expected.key];
        return actual?.id === expected.id && actual.revision === expected.revision;
      })
    : undefined;
  const checks: Record<string, "ok" | "missing" | "error"> = {
    isolatedVenv: existsSync(venvPython) ? "ok" : "missing",
    manifest: manifest ? "ok" : "missing",
    runtimeState: state ? "ok" : "missing",
    fsmnVadModel: state?.models?.fsmnVad && existsSync(state.models.fsmnVad.path) ? "ok" : "missing",
    senseVoiceModel: state?.models?.senseVoice && existsSync(state.models.senseVoice.path) ? "ok" : "missing",
    modelVersions: modelVersionsMatch === true ? "ok" : modelVersionsMatch === false ? "error" : "missing",
    runtimeVersion:
      manifest && state &&
      manifest.runtimeManifestVersion === state.runtimeManifestVersion &&
      manifest.asrEnvironmentVersion === state.asrEnvironmentVersion
        ? "ok"
        : state ? "error" : "missing",
  };
  return {
    ready: Object.values(checks).every((value) => value === "ok"),
    checks,
    details: {
      venvPython,
      manifest: manifestFile,
      state: stateFile,
      models: modelsDir,
    },
    state,
  };
}
