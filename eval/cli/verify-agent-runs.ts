import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAgentRuns } from "../verify.js";
import { AgentRunSchema } from "../schema.js";
import { loadSkillCases } from "../verify-helper.js";

/**
 * 扫描已落盘的 Agent Run 并跑确定性 + 语义检查。
 *
 * 用法：
 *   npm run agent-run:verify
 *   npm run agent-run:verify -- --dir path/to/agent-runs --skill-cases path/to/skill-cases.json
 *
 * 默认扫描 tests/agent-runs/ 并对照 tests/skill-cases.json。
 */
async function main(): Promise<void> {
  const dirIdx = process.argv.indexOf("--dir");
  const casesIdx = process.argv.indexOf("--skill-cases");
  const directory =
    dirIdx >= 0 && process.argv[dirIdx + 1] ? process.argv[dirIdx + 1]! : undefined;
  const skillCasesPath =
    casesIdx >= 0 && process.argv[casesIdx + 1]
      ? process.argv[casesIdx + 1]!
      : undefined;

  let result;
  try {
    result = await verifyAgentRuns({ directory, skillCasesPath });
  } catch (err: unknown) {
    console.error(`验证失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`已扫描 Agent Run：${result.total} 个 case 最新记录`);
  console.log(`  通过：${result.passed}`);
  console.log(`  失败：${result.failed}`);
  console.log(`  待 Judge：${result.pending}（语义 PENDING — 不算 PASS 也不算 FAIL）`);

  // 按 execution 分类: real_agent (真实 Agent E2E) 跟 demo_fixture (协议演示)
  await printExecutionBreakdown(directory);

  // 语义评分概览：每条 case 的每个维度展示 "score / threshold" 状态
  await printSemanticOverview(directory, skillCasesPath);

  if (result.missingCaseIds.length > 0) {
    console.log(`\n尚未跑过的 case（${result.missingCaseIds.length} 个）：`);
    for (const id of result.missingCaseIds) {
      console.log(`  - ${id}`);
    }
  }

  if (result.pendingSemanticJudge.length > 0) {
    console.log(
      `\n待跑 LLM Semantic Judge 的 case（${result.pendingSemanticJudge.length} 个）：`,
    );
    for (const p of result.pendingSemanticJudge) {
      console.log(`  - ${p.caseId}（${p.criteriaCount} 个评分维度）`);
    }
    console.log("  → 跑法：npm run agent-run:judge -- --case <caseId>");
  }

  if (result.warnings.length > 0) {
    console.log(`\n警告（${result.warnings.length} 条）：`);
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (result.failed > 0 || result.warnings.length > 0) {
    process.exitCode = 1;
  }
}

async function printSemanticOverview(
  directory: string | undefined,
  skillCasesPath: string | undefined,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const runsDir =
    directory ?? join(process.cwd(), "tests", "agent-runs");
  const casesPath =
    skillCasesPath ?? join(process.cwd(), "tests", "skill-cases.json");

  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return;
  }

  const skillCases = await loadSkillCases(casesPath);
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readFile(join(runsDir, entry), "utf8");
    let run;
    try {
      run = AgentRunSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
    const sc = skillCases.get(run.caseId);
    if (!sc?.semantic_criteria || sc.semantic_criteria.length === 0) continue;
    const scores = run.evaluation?.semantic ?? [];
    if (scores.length === 0) continue;

    lines.push(`  ${run.caseId}:`);
    for (const c of sc.semantic_criteria) {
      const entry = scores.find((s) => s.criterion === c.name);
      const score = entry?.score;
      if (score === undefined) {
        lines.push(`    - ${c.name}：未评分`);
      } else {
        const status = score >= c.threshold ? "✓" : "✗";
        lines.push(
          `    - ${c.name}：${score.toFixed(2)} / ${c.threshold} ${status}`,
        );
      }
    }
  }
  if (lines.length > 0) {
    console.log(`\n语义评分概览：`);
    console.log(lines.join("\n"));
  }
}

/**
 * 按 execution 分类统计: real_agent (真实 Agent 端到端跑) 跟 demo_fixture (协议演示).
 *
 * 验收报告里真实 E2E 跟 fixture 演示要分开看, 防止 28 Runs = 28 个真实 E2E 这种误解.
 */
async function printExecutionBreakdown(
  directory: string | undefined,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const runsDir = directory ?? join(process.cwd(), "tests", "agent-runs");
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return;
  }
  const counts = { real_agent: 0, demo_fixture: 0, unknown: 0 };
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readFile(join(runsDir, entry), "utf8");
    let run;
    try {
      run = AgentRunSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
    const exe = run.execution ?? "unknown";
    if (exe in counts) {
      counts[exe as keyof typeof counts]++;
    } else {
      counts.unknown++;
    }
  }
  console.log(`\n按 execution 分类:`);
  console.log(`  real_agent: ${counts.real_agent}（真实 Agent 加载 Skill + 真实 Tool + 真实回答）`);
  console.log(`  demo_fixture: ${counts.demo_fixture}（协议演示, 含 {{video}} 或 BV_FIXTURE_* 占位符, 非真实 E2E）`);
  if (counts.unknown > 0) {
    console.log(`  unknown: ${counts.unknown}（无 execution 字段, 建议补）`);
  }
}

await main();
