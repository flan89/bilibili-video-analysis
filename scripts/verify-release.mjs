import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bilibili-skill-release-"));
try {
  const release = spawnSync(process.execPath, ["scripts/build-release.mjs", "--output", tempRoot], {
    cwd: process.cwd(), encoding: "utf8",
  });
  if (release.status !== 0) throw new Error(release.stderr || "发布物生成失败");
  const artifact = path.join(tempRoot, "bilibili-video-analysis");
  const required = ["SKILL.md", "VERSION", "LICENSE", "references", "runtime/python", "dist/cli.mjs"];
  const forbidden = ["node_modules", "package.json", "scripts", "tests", "eval", "development"];
  for (const item of required) {
    if (!existsSync(path.join(artifact, item))) throw new Error(`发布物缺少 ${item}`);
  }
  for (const item of forbidden) {
    if (existsSync(path.join(artifact, item))) throw new Error(`发布物不应包含 ${item}`);
  }
  const artifactEntries = await readdir(artifact, { recursive: true });
  const forbiddenSystemFiles = artifactEntries.filter((item) => path.basename(item) === ".DS_Store");
  if (forbiddenSystemFiles.length > 0) {
    throw new Error(`发布物不应包含系统文件: ${forbiddenSystemFiles.join(", ")}`);
  }

  const help = spawnSync(process.execPath, [path.join(artifact, "dist/cli.mjs"), "help"], {
    cwd: tempRoot, encoding: "utf8",
  });
  if (help.status !== 0 || !help.stdout.includes("tool")) throw new Error(help.stderr || "help 冒烟失败");

  const tool = spawnSync(
    process.execPath,
    [path.join(artifact, "dist/cli.mjs"), "tool", "metadata", '{"video":"not-a-video"}'],
    { cwd: os.tmpdir(), encoding: "utf8" },
  );
  if (tool.status !== 0 || !tool.stdout.includes("invalid_video_input")) {
    throw new Error(tool.stderr || "Tool 冒烟失败");
  }
  // M7: search-videos 注册与输入校验冒烟 (不触网络).
  // 与 metadata 不同: 非法搜索输入是调用方错误, Tool 直接 throw ZodError,
  // CLI 捕获后以 exit 1 + stderr 结构化错误 JSON 输出 (批次 A 既定行为).
  const searchTool = spawnSync(
    process.execPath,
    [path.join(artifact, "dist/cli.mjs"), "tool", "search-videos", '{"query":""}'],
    { cwd: os.tmpdir(), encoding: "utf8" },
  );
  if (searchTool.status !== 1 || !searchTool.stderr.includes("ZodError")) {
    throw new Error(searchTool.stdout || "search-videos 冒烟失败");
  }
  process.stdout.write("release artifact smoke test: ok\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
