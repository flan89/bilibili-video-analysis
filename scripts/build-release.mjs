import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outputArg = process.argv.indexOf("--output");
const outputRoot = outputArg >= 0 && process.argv[outputArg + 1]
  ? path.resolve(process.argv[outputArg + 1])
  : path.resolve("release");
const artifact = path.join(outputRoot, "bilibili-video-analysis");

// 在生成发布物前阻止不受支持的 Skill 前置字段再次混入。
const skillText = await readFile(path.resolve("SKILL.md"), "utf8");
const frontmatterMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!frontmatterMatch) throw new Error("SKILL.md 缺少有效 YAML frontmatter");
const allowedKeys = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
]);
const topLevelKeys = frontmatterMatch[1]
  .split(/\r?\n/)
  .filter((line) => line.length > 0 && !/^\s/.test(line))
  .map((line) => line.match(/^([A-Za-z0-9_-]+):/)?.[1])
  .filter(Boolean);
for (const key of topLevelKeys) {
  if (!allowedKeys.has(key)) throw new Error(`SKILL.md 包含不受支持的前置字段: ${key}`);
}
if (!topLevelKeys.includes("name") || !topLevelKeys.includes("description")) {
  throw new Error("SKILL.md frontmatter 必须包含 name 和 description");
}

const buildResult = spawnSync(process.execPath, ["scripts/build-runtime.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);

await rm(artifact, { recursive: true, force: true });
await mkdir(artifact, { recursive: true });
for (const name of ["SKILL.md", "VERSION", "LICENSE", "references", "runtime", "dist"]) {
  await cp(path.resolve(name), path.join(artifact, name), {
    recursive: true,
    filter: (source) =>
      !source.includes("__pycache__")
      && !source.endsWith(".pyc")
      && path.basename(source) !== ".DS_Store",
  });
}

process.stdout.write(`${artifact}\n`);
