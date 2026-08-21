/**
 * LLM Semantic Judge 框架。
 *
 * 设计目标：
 * - 让 Skill case 声明"内容质量评分维度"（semantic_criteria）；
 * - 让 verify / CLI 工具能基于此生成 LLM Judge prompt；
 * - 跑 LLM Judge 的真实调用留接口位（`runSemanticJudgeWithLLM`），
 *   由调用方（CLI / 外部脚本 / 用户）注入 LLM 调用函数。
 *
 * 与只依赖临时人工检查相比：
 * - 维度由 case 作者用结构化字段声明，公开可读、可比较；
 * - 生成的 prompt 是稳定的（相同 case + run 必产生相同 prompt），
 *   方便人工事后补打分时也能复用；
 * - 真实 LLM Judge 跑出来的分数可写回 `AgentRun.evaluation.semantic`，
 *   与 deterministic 检查一并被 verify 工具读取。
 */
import { z } from "zod";

/**
 * 单条评分维度。
 * 0-1 阈值，低于此值视为未通过；description 给 LLM 看。
 */
export const SemanticCriterionSchema = z
  .object({
    /** 评分维度名称（也作为写回 AgentRun.evaluation.semantic 的 key）。 */
    name: z.string().min(1),
    /** 评分说明，给 LLM Judge 读。 */
    description: z.string().min(1),
    /** 0-1 阈值；评分低于此值视为未通过。 */
    threshold: z.number().min(0).max(1),
  })
  .strict();
export type SemanticCriterion = z.infer<typeof SemanticCriterionSchema>;

export const SemanticCriteriaSchema = z
  .array(SemanticCriterionSchema)
  .default([]);
export type SemanticCriteria = z.infer<typeof SemanticCriteriaSchema>;

/**
 * LLM Judge 的标准化返回结构。
 * 每个 dimension 一个 0-1 浮点分；overall 由调用方根据 threshold 推导。
 */
export const SemanticJudgeResultSchema = z
  .object({
    /** 维度名 → 0-1 分数 */
    scores: z.record(z.string(), z.number().min(0).max(1)),
    /** 1-2 句解释，便于人工 review。 */
    rationale: z.string().default(""),
  })
  .strict();
export type SemanticJudgeResult = z.infer<typeof SemanticJudgeResultSchema>;

/**
 * 最小化的 case 描述，用于拼 prompt 时只取必要字段。
 * 避免直接 import SkillCase 让模块依赖耦合到验证路径。
 */
export interface JudgeCaseContext {
  caseId: string;
  category: string;
  userRequest: string;
  expectedRequiredActions: readonly string[];
  expectedForbiddenBehaviors: readonly string[];
  criteria: SemanticCriteria;
}

/**
 * 最小化的 run 描述，用于拼 prompt 时只取必要字段。
 */
export interface JudgeRunContext {
  caseId: string;
  prompt: string;
  toolTrace: ReadonlyArray<{ tool: string; outcome?: string }>;
  finalAnswer: string;
}

/**
 * 生成稳定的 LLM Judge prompt。
 *
 * 关键设计：
 * - 输入（case + run）确定时，输出 prompt 字符级稳定，便于回归与人工 review；
 * - 不调用任何 LLM，纯字符串拼装；
 * - 不暴露 prompt 之外的隐藏指令（防 prompt injection 在 case 字段里）。
 */
export function buildJudgePrompt(
  caseCtx: JudgeCaseContext,
  runCtx: JudgeRunContext,
): string {
  const lines: string[] = [];
  lines.push("# LLM Semantic Judge");
  lines.push("");
  lines.push("你是 Skill E2E Eval 的 LLM Judge。你的任务是按下面的维度给一个 Agent 的回答打分。");
  lines.push("");
  lines.push("## 评分原则");
  lines.push("- 0.0 = 完全不满足；1.0 = 完美满足。");
  lines.push("- 评分必须有具体依据；如果发现 Agent 编造内容或绕过要求，给 0 分。");
  lines.push("- 不要因为回答「看起来全面」就给高分；按维度严格打分。");
  lines.push("");
  lines.push("## Case 信息");
  lines.push(`- caseId: ${caseCtx.caseId}`);
  lines.push(`- category: ${caseCtx.category}`);
  lines.push(`- 用户原始 Prompt: ${caseCtx.userRequest}`);
  lines.push("");
  lines.push("### Case 期望行为");
  for (const a of caseCtx.expectedRequiredActions) {
    lines.push(`- 必须：${a}`);
  }
  for (const b of caseCtx.expectedForbiddenBehaviors) {
    lines.push(`- 禁止：${b}`);
  }
  lines.push("");
  lines.push("## Agent 实际行为");
  lines.push(`- 实际 Prompt: ${runCtx.prompt}`);
  lines.push("- 工具调用：");
  if (runCtx.toolTrace.length === 0) {
    lines.push("  - (无)");
  } else {
    for (const t of runCtx.toolTrace) {
      const outcome = t.outcome ? ` [${t.outcome}]` : "";
      lines.push(`  - ${t.tool}${outcome}`);
    }
  }
  lines.push("- 最终回答：");
  lines.push("```");
  lines.push(runCtx.finalAnswer);
  lines.push("```");
  lines.push("");
  lines.push("## 评分维度");
  if (caseCtx.criteria.length === 0) {
    lines.push("(本 case 未声明 semantic_criteria；跳过语义评分)");
  } else {
    for (const c of caseCtx.criteria) {
      lines.push(`### ${c.name}（阈值 ${c.threshold}）`);
      lines.push(c.description);
    }
  }
  lines.push("");
  lines.push("## 返回格式");
  lines.push("请返回严格 JSON（不要包裹在 markdown 代码块里）：");
  lines.push(`{ "scores": { ${caseCtx.criteria.map((c) => `"${c.name}": <0-1 浮点>`).join(", ")} }, "rationale": "<1-2 句解释>" }`);
  return lines.join("\n");
}

/**
 * 根据 threshold 判断每条维度是否通过，并汇总。
 */
export function summarizeJudgeResult(
  result: SemanticJudgeResult,
  criteria: SemanticCriteria,
): {
  passed: boolean;
  perCriterion: Array<{ name: string; score: number; threshold: number; passed: boolean }>;
  failedCriteria: string[];
} {
  const perCriterion = criteria.map((c) => {
    const score = result.scores[c.name] ?? 0;
    return { name: c.name, score, threshold: c.threshold, passed: score >= c.threshold };
  });
  const failedCriteria = perCriterion.filter((c) => !c.passed).map((c) => c.name);
  return {
    passed: failedCriteria.length === 0,
    perCriterion,
    failedCriteria,
  };
}

/**
 * LLM Judge 调用接口。
 *
 * 留接口位的原因：
 * - 运行时 Tool 不调用第二套模型；
 * - Judge 是测试基础设施而非生产 Tool；
 * - 真实 LLM 调用由调用方注入，单元测试可传 mock 响应。
 *
 * 默认实现返回占位 result（不实际调 LLM），保证 verify / CLI dry-run 流程可跑。
 */
export interface LlmCallOptions {
  /** LLM 调用函数；测试时可注入 mock。 */
  call: (prompt: string) => Promise<string>;
}

export async function runSemanticJudgeWithLLM(
  caseCtx: JudgeCaseContext,
  runCtx: JudgeRunContext,
  options: LlmCallOptions,
): Promise<SemanticJudgeResult> {
  const prompt = buildJudgePrompt(caseCtx, runCtx);
  const raw = await options.call(prompt);
  // LLM 输出可能包裹 markdown 代码块；尽量宽松解析。
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `LLM Judge 返回非 JSON：${err instanceof Error ? err.message : String(err)}\n原始返回：${raw.slice(0, 500)}`,
    );
  }
  return SemanticJudgeResultSchema.parse(parsed);
}
