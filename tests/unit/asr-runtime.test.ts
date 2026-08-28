import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectAsrRuntime, type AsrRuntimeManifest, type AsrRuntimeState } from "../../scripts/lib/asr-runtime.js";

describe("ASR Runtime 状态核验", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "asr-runtime-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(options: { state?: boolean; modelRevision?: string } = {}) {
    const manifestFile = path.join(root, "runtime-manifest.json");
    const stateFile = path.join(root, "runtime.json");
    const venvPython = path.join(root, "venv", "bin", "python");
    const vadPath = path.join(root, "models", "vad");
    const sensePath = path.join(root, "models", "sense");
    const manifest: AsrRuntimeManifest = {
      runtimeManifestVersion: 1,
      asrEnvironmentVersion: 1,
      pythonMin: "3.10",
      models: [
        { key: "fsmnVad", id: "iic/vad", revision: "vad-r1" },
        { key: "senseVoice", id: "iic/sense", revision: "sense-r1" },
      ],
    };
    await mkdir(path.dirname(venvPython), { recursive: true });
    await mkdir(vadPath, { recursive: true });
    await mkdir(sensePath, { recursive: true });
    await writeFile(venvPython, "");
    await writeFile(manifestFile, JSON.stringify(manifest));
    if (options.state !== false) {
      const state: AsrRuntimeState = {
        runtimeManifestVersion: 1,
        asrEnvironmentVersion: 1,
        preparedAt: "2026-08-20T00:00:00.000Z",
        pythonVersion: "3.12.0",
        models: {
          fsmnVad: { id: "iic/vad", revision: "vad-r1", path: vadPath },
          senseVoice: {
            id: "iic/sense",
            revision: options.modelRevision ?? "sense-r1",
            path: sensePath,
          },
        },
      };
      await writeFile(stateFile, JSON.stringify(state));
    }
    return { manifestFile, stateFile, venvPython, modelsDir: path.join(root, "models") };
  }

  it("状态文件缺失时不可用", async () => {
    const paths = await fixture({ state: false });
    const result = inspectAsrRuntime(paths);
    expect(result.ready).toBe(false);
    expect(result.checks.runtimeState).toBe("missing");
    expect(result.checks.modelVersions).toBe("missing");
  });

  it("关键文件与版本一致时 ready", async () => {
    const paths = await fixture();
    const result = inspectAsrRuntime(paths);
    expect(result.ready).toBe(true);
    expect(result.checks.modelVersions).toBe("ok");
  });

  it("模型 revision 与运行清单不一致时不可用", async () => {
    const paths = await fixture({ modelRevision: "old-revision" });
    const result = inspectAsrRuntime(paths);
    expect(result.ready).toBe(false);
    expect(result.checks.modelVersions).toBe("error");
  });
});
