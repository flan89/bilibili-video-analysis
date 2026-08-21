/**
 * 跑 LLM Semantic Judge 的 CLI 入口。
 *
 * 默认行为：dry-run 模式，根据 --case / --all 拼出 Judge prompt 并打印到 stdout，
 * 调用方（Mavis / 外部脚本 / 用户）拿到 prompt 后可手工事后填分或接入真实 LLM。
 *
 * 真实 LLM Judge 调用留接口位（`runSemanticJudgeWithLLM` in
 * scripts/agent-run/semantic-judge.ts），由调用方注入 LLM 调用函数：
 *
 *   import { runSemanticJudgeWithLLM } from "../semantic-judge.js";
 *   import { callLLM } from "./your-llm-client.js";
 *   const result = await runSemanticJudgeWithLLM(caseCtx, runCtx, { call: callLLM });
 *
 * 用法：
 *   npm run agent-run:judge -- --case <caseId>           # dry-run 输出 prompt
 *   npm run agent-run:judge -- --all                      # 全部 pending Judge case
 *   npm run agent-run:judge -- --list                     # 列出 pending Judge case
 *   npm run agent-run:judge -- --case <id> --write-score  # 把人工/外部打分写回 AgentRun
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentRunSchema,
  type AgentRun,
} from "../schema.js";
import { loadSkillCases } from "../verify-helper.js";
import {
  buildJudgePrompt,
  summarizeJudgeResult,
  runSemanticJudgeWithLLM,
  type JudgeCaseContext,
  type JudgeRunContext,
  type SemanticCriteria,
} from "../semantic-judge.js";
import { dumpAgentRun } from "../dump.js";
import type { SkillCase } from "../verify-helper.js";

interface RunJudgeOptions {
  caseId?: string;
  all?: boolean;
  list?: boolean;
  writeScore?: boolean;
  /** 外部 LLM 调用函数（待后续接入）。 */
  llmCall?: (prompt: string) => Promise<string>;
}

function toJudgeCaseContext(
  skillCase: SkillCase,
  userRequest: string,
): JudgeCaseContext {
  return {
    caseId: skillCase.id,
    category: skillCase.category,
    userRequest,
    expectedRequiredActions: skillCase.expected.required_actions,
    expectedForbiddenBehaviors: skillCase.expected.forbidden_behaviors,
    criteria: skillCase.semantic_criteria ?? [],
  };
}

function toJudgeRunContext(run: AgentRun): JudgeRunContext {
  return {
    caseId: run.caseId,
    prompt: run.prompt,
    toolTrace: run.toolTrace.map((c) => ({ tool: c.tool, outcome: c.outcome })),
    finalAnswer: run.finalAnswer,
  };
}

async function loadAgentRun(caseId: string, runsDir: string): Promise<AgentRun> {
  const path = join(runsDir, `${caseId}.json`);
  const raw = await readFile(path, "utf8");
  return AgentRunSchema.parse(JSON.parse(raw));
}

async function writeSemanticBack(
  run: AgentRun,
  result: { scores: Record<string, number>; rationale?: string },
  runsDir: string,
): Promise<void> {
  // 把 score 写为 evaluation.semantic 数组（schema 已有）
  const existingSemantic = run.evaluation?.semantic ?? [];
  const newEntries = Object.entries(result.scores).map(([criterion, score]) => ({
    criterion,
    score,
    note: result.rationale,
  }));
  const existingDeterministic = run.evaluation?.deterministic ?? [];
  const updated: AgentRun = {
    ...run,
    evaluation: {
      deterministic: existingDeterministic,
      semantic: [...existingSemantic, ...newEntries],
      summary: run.evaluation?.summary,
    },
    recordedAt: run.recordedAt,
  };
  // 用 force=true 允许覆盖
  await dumpAgentRun(updated, { directory: runsDir, force: true });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts: RunJudgeOptions = {
    caseId: pickValue(args, "--case"),
    all: args.includes("--all"),
    list: args.includes("--list"),
    writeScore: args.includes("--write-score"),
  };
  const dirIdx = args.indexOf("--dir");
  const runsDir =
    dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1]! : join(process.cwd(), "tests", "agent-runs");
  const casesIdx = args.indexOf("--skill-cases");
  const skillCasesPath =
    casesIdx >= 0 && args[casesIdx + 1]
      ? args[casesIdx + 1]!
      : join(process.cwd(), "tests", "skill-cases.json");

  const skillCases = await loadSkillCases(skillCasesPath);

  // 收集待跑 Judge 的 case
  const pending: string[] = [];
  for (const [id, sc] of skillCases) {
    if (sc.semantic_criteria && sc.semantic_criteria.length > 0) {
      pending.push(id);
    }
  }
  pending.sort();

  if (opts.list) {
    console.log(`声明了 semantic_criteria 的 case（${pending.length} 个）：`);
    for (const id of pending) {
      console.log(`  - ${id}`);
    }
    return;
  }

  if (opts.caseId) {
    await judgeOne(opts.caseId, skillCases, runsDir, opts);
  } else if (opts.all) {
    for (const id of pending) {
      await judgeOne(id, skillCases, runsDir, opts);
    }
  } else {
    console.log("用法：");
    console.log("  --case <caseId>   跑指定 case 的 Judge prompt（dry-run）");
    console.log("  --all             跑全部声明了 semantic_criteria 的 case");
    console.log("  --list            列出待跑 Judge 的 case");
    console.log("  --write-score     把 Judge 结果写回 AgentRun（需配合 LLM 调用）");
  }
}

async function judgeOne(
  caseId: string,
  skillCases: Map<string, SkillCase>,
  runsDir: string,
  opts: RunJudgeOptions,
): Promise<void> {
  const skillCase = skillCases.get(caseId);
  if (!skillCase) {
    console.error(`[${caseId}] skill-case 不存在`);
    return;
  }
  if (!skillCase.semantic_criteria || skillCase.semantic_criteria.length === 0) {
    console.error(`[${caseId}] 未声明 semantic_criteria，跳过`);
    return;
  }

  let run: AgentRun;
  try {
    run = await loadAgentRun(caseId, runsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${caseId}] AgentRun 不存在：${msg}`);
    return;
  }

  const caseCtx = toJudgeCaseContext(skillCase, skillCase.user_request ?? "");
  const runCtx = toJudgeRunContext(run);
  const prompt = buildJudgePrompt(caseCtx, runCtx);

  if (!opts.llmCall) {
    // dry-run：把 prompt 打印到 stdout，便于人工事后补打分或外部脚本接管
    console.log(`# === ${caseId} Judge Prompt ===`);
    console.log(prompt);
    console.log(`# === end ${caseId} ===\n`);
    return;
  }

  // 真实 LLM Judge 路径
  const result = await runSemanticJudgeWithLLM(caseCtx, runCtx, {
    call: opts.llmCall,
  });
  const summary = summarizeJudgeResult(result, skillCase.semantic_criteria);
  console.log(`[${caseId}] passed=${summary.passed} failed=${summary.failedCriteria.join(",") || "none"}`);

  if (opts.writeScore) {
    await writeSemanticBack(run, result, runsDir);
    console.log(`[${caseId}] 已写回 evaluation.semantic`);
  }
}

function pickValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

await main();
