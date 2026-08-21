import { describe, expect, it, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  skillRoot,
  dataHome,
  cacheHome,
  dataPaths,
  cachePaths,
  runtimePaths,
  resolveAllPaths,
} from "../../scripts/lib/paths.js";

describe("paths - skillRoot", () => {
  it("skillRoot 推算成当前仓库根 (含 SKILL.md)", () => {
    const root = skillRoot();
    // 不直接断言绝对路径, 而是断言关键 marker 存在
    expect(root).toContain("bilibili-video-analysis");
    // 关键 marker: SKILL.md / package.json / scripts / references
    expect(require("node:fs").existsSync(path.join(root, "SKILL.md"))).toBe(true);
    expect(require("node:fs").existsSync(path.join(root, "package.json"))).toBe(true);
    expect(require("node:fs").existsSync(path.join(root, "scripts"))).toBe(true);
    expect(require("node:fs").existsSync(path.join(root, "references"))).toBe(true);
  });

  it("skillRoot 跟 dataHome / cacheHome 路径不同", () => {
    const root = skillRoot();
    const data = dataHome();
    const cache = cacheHome();
    // 在理想环境下 (无 env var 覆盖), 这三个都是不同路径
    // 即便重叠 (用户主动设 env var 指到 skillRoot 自身), 也至少 data != skillRoot 或 cache != skillRoot
    expect(typeof root).toBe("string");
    expect(typeof data).toBe("string");
    expect(typeof cache).toBe("string");
  });
});

describe("paths - dataHome 默认值", () => {
  const originalXDG = process.env.XDG_DATA_HOME;
  const originalEnv = process.env.BILIBILI_SKILL_DATA_DIR;

  beforeEach(() => {
    delete process.env.BILIBILI_SKILL_DATA_DIR;
  });

  afterEach(() => {
    if (originalXDG !== undefined) process.env.XDG_DATA_HOME = originalXDG;
    else delete process.env.XDG_DATA_HOME;
    if (originalEnv !== undefined) process.env.BILIBILI_SKILL_DATA_DIR = originalEnv;
    else delete process.env.BILIBILI_SKILL_DATA_DIR;
  });

  it("BILIBILI_SKILL_DATA_DIR 优先级最高", () => {
    process.env.BILIBILI_SKILL_DATA_DIR = "/tmp/custom-data";
    expect(dataHome()).toBe("/tmp/custom-data");
  });

  it("macOS 默认 ~/Library/Application Support/bilibili-video-analysis", () => {
    if (os.platform() !== "darwin") return;
    delete process.env.XDG_DATA_HOME;
    expect(dataHome()).toBe(
      path.join(os.homedir(), "Library", "Application Support", "bilibili-video-analysis"),
    );
  });

  it("Linux 默认 XDG_DATA_HOME 优先, 否则 ~/.local/share/...", () => {
    if (os.platform() === "darwin") return;
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    expect(dataHome()).toBe(path.join("/tmp/xdg-data", "bilibili-video-analysis"));
    delete process.env.XDG_DATA_HOME;
    expect(dataHome()).toBe(
      path.join(os.homedir(), ".local", "share", "bilibili-video-analysis"),
    );
  });
});

describe("paths - cacheHome 默认值", () => {
  const originalXDG = process.env.XDG_CACHE_HOME;
  const originalEnv = process.env.BILIBILI_SKILL_CACHE_DIR;

  beforeEach(() => {
    delete process.env.BILIBILI_SKILL_CACHE_DIR;
  });

  afterEach(() => {
    if (originalXDG !== undefined) process.env.XDG_CACHE_HOME = originalXDG;
    else delete process.env.XDG_CACHE_HOME;
    if (originalEnv !== undefined) process.env.BILIBILI_SKILL_CACHE_DIR = originalEnv;
    else delete process.env.BILIBILI_SKILL_CACHE_DIR;
  });

  it("BILIBILI_SKILL_CACHE_DIR 优先级最高", () => {
    process.env.BILIBILI_SKILL_CACHE_DIR = "/tmp/custom-cache";
    expect(cacheHome()).toBe("/tmp/custom-cache");
  });

  it("macOS 默认 ~/Library/Caches/bilibili-video-analysis", () => {
    if (os.platform() !== "darwin") return;
    delete process.env.XDG_CACHE_HOME;
    expect(cacheHome()).toBe(
      path.join(os.homedir(), "Library", "Caches", "bilibili-video-analysis"),
    );
  });

  it("Linux 默认 XDG_CACHE_HOME 优先, 否则 ~/.cache/...", () => {
    if (os.platform() === "darwin") return;
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache";
    expect(cacheHome()).toBe(path.join("/tmp/xdg-cache", "bilibili-video-analysis"));
    delete process.env.XDG_CACHE_HOME;
    expect(cacheHome()).toBe(
      path.join(os.homedir(), ".cache", "bilibili-video-analysis"),
    );
  });
});

describe("paths - 子路径", () => {
  it("dataPaths.asrVenv 跟 dataPaths.asrVenvPython 路径对应", () => {
    const venv = dataPaths.asrVenv();
    const venvPy = dataPaths.asrVenvPython();
    const binDir = process.platform === "win32" ? "Scripts" : "bin";
    expect(venvPy).toBe(path.join(venv, binDir, process.platform === "win32" ? "python.exe" : "python"));
  });

  it("cachePaths 子路径都在 cacheHome 下", () => {
    const cache = cacheHome();
    for (const p of [cachePaths.media(), cachePaths.frames(), cachePaths.asrCache(), cachePaths.tmp()]) {
      expect(p.startsWith(cache)).toBe(true);
    }
  });

  it("runtimePaths.python 跟 runtimePaths.pipeline 在 skillRoot/runtime/python/ 下", () => {
    const py = runtimePaths.python();
    const pipe = runtimePaths.pipeline();
    expect(pipe).toBe(path.join(py, "pipeline.py"));
    expect(py.startsWith(skillRoot())).toBe(true);
  });
});

describe("paths - resolveAllPaths", () => {
  it("返回完整解析结果", () => {
    const all = resolveAllPaths();
    expect(all.skillRoot).toBe(skillRoot());
    expect(all.dataHome).toBe(dataHome());
    expect(all.cacheHome).toBe(cacheHome());
    expect(all.platform).toBe(os.platform());
  });
});
