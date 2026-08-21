import { readFile } from "node:fs/promises";
import { dumpAgentRun } from "../dump.js";
import { AgentRunSchema } from "../schema.js";

/**
 * 手工 / 半自动保存 Agent Run 的 CLI 入口。
 *
 * 用法：
 * - 从文件：  npm run agent-run:dump -- --from path/to/agent-run.json
 * - 从 stdin： cat agent-run.json | npm run agent-run:dump
 *
 * 默认输出目录为 tests/agent-runs/，文件名为 <caseId>.json。
 * 已有同名文件且未传 --force 时拒绝写入。
 */
async function readPayload(): Promise<unknown> {
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx >= 0) {
    const path = process.argv[fromIdx + 1];
    if (!path) {
      throw new Error("--from 之后必须提供 JSON 文件路径");
    }
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  }
  // 从 stdin 读取
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    throw new Error(
      "未检测到输入。请通过 --from 传入 JSON 文件，或通过 stdin 喂入 JSON。",
    );
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const directoryIdx = process.argv.indexOf("--dir");
  const directory =
    directoryIdx >= 0 ? process.argv[directoryIdx + 1] : undefined;

  let payload: unknown;
  try {
    payload = await readPayload();
  } catch (err: unknown) {
    console.error(`读取输入失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let run;
  try {
    run = AgentRunSchema.parse(payload);
  } catch (err: unknown) {
    console.error(
      `Agent Run 不符合 schema：${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = await dumpAgentRun(run, { force, directory });
    console.log(`已写入 Agent Run：caseId=${result.caseId}${result.path ? ` path=${result.path}` : ""}`);
  } catch (err: unknown) {
    console.error(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

await main();
