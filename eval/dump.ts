/**
 * 写入 Agent Run 到 tests/agent-runs/ 的工具函数。
 *
 * 路径策略：
 * - 文件名固定为 `<caseId>.json`，避免和 skill-cases.json 多对多匹配；
 * - 默认目录为仓库内 `tests/agent-runs/`，可被调用方覆盖；
 * - 不覆盖已有文件，除非显式 force=true，用于防止误覆盖手工记录。
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AgentRunSchema, type AgentRun } from "./schema.js";

export interface DumpAgentRunOptions {
  /** 目标目录；默认 tests/agent-runs。 */
  directory?: string;
  /** 是否覆盖已有同名文件。 */
  force?: boolean;
  /** 落盘后是否返回完整路径。 */
  returnPath?: boolean;
}

export interface DumpAgentRunResult {
  caseId: string;
  path?: string;
}

/**
 * 把一个 Agent Run 写到 JSON 文件。
 * 返回 caseId 与（可选）落盘路径。
 * 当目标文件已存在且未传 force 时抛错，避免手工记录被误覆盖。
 */
export async function dumpAgentRun(
  run: AgentRun,
  options: DumpAgentRunOptions = {},
): Promise<DumpAgentRunResult> {
  // 先做 schema 校验，失败时直接抛错，避免把非法 JSON 写入磁盘。
  const validated = AgentRunSchema.parse(run);

  const directory = resolve(
    options.directory ?? join(process.cwd(), "tests", "agent-runs"),
  );
  await mkdir(directory, { recursive: true });

  const filename = `${validated.caseId}.json`;
  const fullPath = join(directory, filename);

  // force=false 时拒绝覆盖
  if (!options.force) {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(fullPath);
      throw new Error(
        `Agent Run 已存在且未开启 force：${fullPath}。如确认要覆盖请显式传入 force=true。`,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Agent Run 已存在")) {
        throw err;
      }
      // 不存在时 stat 抛 ENOENT，正常路径
    }
  }

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(validated, null, 2) + "\n", "utf8");

  return options.returnPath
    ? { caseId: validated.caseId, path: fullPath }
    : { caseId: validated.caseId };
}
