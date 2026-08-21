/**
 * scripts/lib/paths.ts: 解析 Skill Runtime 的所有路径.
 *
 * 三个根:
 * - skillRoot: skill 安装目录 (read-only, 由 import.meta.url 推算)
 * - dataHome: 用户数据 (venv / models / state, 长期保留, 升级不删)
 * - cacheHome: 临时缓存 (downloads / frames / transcripts, 可重新生成, 可 TTL 清理)
 *
 * 跨平台:
 * - Linux:  XDG Base Directory 规范
 * - macOS:  Apple Application Support 规范
 * - 都不支持: 默认 ~/.local/share + ~/.cache
 *
 * 覆盖: 环境变量 BILIBILI_SKILL_DATA_DIR / BILIBILI_SKILL_CACHE_DIR 优先级最高
 *        (CI / 测试 / Docker / 用户自定义大磁盘)
 */
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skill 安装目录 (read-only).
 *
 * 算法: 从 import.meta.url 出发, 向上找最近的 SKILL.md.
 * 正式发布物不携带 package.json，因此不能把它作为识别条件。
 *
 * fallback: 找不到时返回 3 层 .. (跟历史行为兼容).
 */
export function skillRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(cur, "SKILL.md"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // 根了
    cur = parent;
  }
  // fallback: 假设跟 commands/tool.ts 同深度 (3 层)
  return path.resolve(here, "..", "..", "..");
}

/** 解析平台默认 Data Home */
function defaultDataHome(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "bilibili-video-analysis");
  }
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "bilibili-video-analysis");
  }
  return path.join(os.homedir(), ".local", "share", "bilibili-video-analysis");
}

/** 解析平台默认 Cache Home */
function defaultCacheHome(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "bilibili-video-analysis");
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "bilibili-video-analysis");
  }
  return path.join(os.homedir(), ".cache", "bilibili-video-analysis");
}

/** 用户数据 (venv / models / state) */
export function dataHome(): string {
  return process.env.BILIBILI_SKILL_DATA_DIR || defaultDataHome();
}

/** 临时缓存 (downloads / frames / transcripts) */
export function cacheHome(): string {
  return process.env.BILIBILI_SKILL_CACHE_DIR || defaultCacheHome();
}

/** Data Home 下的子路径 */
export const dataPaths = {
  /** ASR Python 隔离 venv */
  asrVenv: () => path.join(dataHome(), "runtime", "python", "venv"),
  /** ASR Python 隔离 venv 里的 python 可执行 */
  asrVenvPython: () => {
    const venv = dataPaths.asrVenv();
    if (process.platform === "win32") {
      return path.join(venv, "Scripts", "python.exe");
    }
    return path.join(venv, "bin", "python");
  },
  /** ASR FunASR 模型缓存 */
  asrModels: () => path.join(dataHome(), "models", "asr"),
  /** Skill 运行时 state 文件 (setup status / venv version / model revision) */
  state: () => path.join(dataHome(), "state"),
  /** state 文件具体路径 */
  stateFile: () => path.join(dataHome(), "state", "runtime.json"),
} as const;

/** Cache Home 下的子路径 */
export const cachePaths = {
  /** B 站原始下载 (mp4 / audio m4s) */
  media: () => path.join(cacheHome(), "media"),
  /** 提取的 frames (jpg) */
  frames: () => path.join(cacheHome(), "frames"),
  /** ASR transcript 缓存 (含 cid 隔离) */
  asrCache: () => path.join(cacheHome(), "asr"),
  /** ASR 下载、音频抽取与模型推理的中间文件。 */
  asrWork: () => path.join(cacheHome(), "asr", "work"),
  /** 临时文件 (download in progress) */
  tmp: () => path.join(cacheHome(), "tmp"),
} as const;

/** Skill 自身的 Python 脚本目录 (跟 venv 区分, venv 在 Data Home) */
export const runtimePaths = {
  /** Python 脚本: dev 跟 build 都期望在 <skillRoot>/runtime/python/ */
  python: () => path.join(skillRoot(), "runtime", "python"),
  /** 主 pipeline */
  pipeline: () => path.join(runtimePaths.python(), "pipeline.py"),
  /** ASR runner */
  asrRunner: () => path.join(runtimePaths.python(), "asr-runner.py"),
  /** Python 依赖 lock */
  requirementsLock: () => path.join(runtimePaths.python(), "requirements.lock"),
  /** 固定 ASR 环境与模型版本的运行清单。 */
  manifest: () => path.join(runtimePaths.python(), "runtime-manifest.json"),
  /** 经用户授权后下载模型的脚本。 */
  prepareModels: () => path.join(runtimePaths.python(), "prepare-models.py"),
} as const;

/** 一次性解析并返回所有路径 (供 setup / doctor 等用) */
export function resolveAllPaths(): {
  skillRoot: string;
  dataHome: string;
  cacheHome: string;
  platform: NodeJS.Platform;
} {
  return {
    skillRoot: skillRoot(),
    dataHome: dataHome(),
    cacheHome: cacheHome(),
    platform: os.platform(),
  };
}
