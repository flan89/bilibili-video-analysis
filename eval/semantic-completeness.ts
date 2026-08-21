/**
 * Semantic Criteria 完整性校验（CODEX §2.2）。
 *
 * 规则：
 * - 缺少任何预期 criterion → PENDING；
 * - 出现未知 criterion（run 评分了 case 未声明的） → FAIL；
 * - 同一个 criterion 重复 → FAIL；
 * - 全部 criterion 都有结果后，才根据 threshold 计算 semantic pass/fail。
 *
 * 与 threshold 检查的边界：
 * - 本模块只做"完整性"判断（数据是否齐 + 是否干净）；
 * - threshold 判断（每个 score 是否 >= threshold）在 verify.ts 主流程里跑。
 *
 * 不依赖 SkillCase/AgentRun 的具体 Zod schema，只接受最小结构。
 */
import type { SemanticCriterion } from "./semantic-judge.js";

export interface MinimalSkillCase {
  id: string;
  semantic_criteria?: SemanticCriterion[];
}

export interface MinimalAgentRun {
  caseId: string;
  evaluation?: {
    semantic?: Array<{ criterion: string; score: number; note?: string }>;
  };
}

export interface CompletenessResult {
  /** 是否满足完整性要求（不缺失 / 不未知 / 不重复）。 */
  complete: boolean;
  /** 缺失的 criterion 名称列表（应被 case 声明但 run 没评分）。 */
  missing: string[];
  /** 未知的 criterion 名称列表（run 评分了但 case 没声明）。 */
  unknown: string[];
  /** 重复的 criterion 名称列表（run 多次评分同一 criterion）。 */
  duplicates: string[];
  /** 结构化警告字符串，可直接 push 到 verify warnings 列表。 */
  warnings: string[];
}

export function checkSemanticCriteriaCompleteness(
  run: MinimalAgentRun,
  skillCase: MinimalSkillCase,
): CompletenessResult {
  const expected = (skillCase.semantic_criteria ?? []).map((c) => c.name);
  const actual = run.evaluation?.semantic ?? [];
  const expectedSet = new Set(expected);
  const warnings: string[] = [];
  const tag = `[case ${run.caseId}]`;

  // 1) 缺：expected 中有但 actual 中没有
  const missing: string[] = [];
  for (const name of expected) {
    if (!actual.some((s) => s.criterion === name)) {
      missing.push(name);
    }
  }

  // 2) 未知：actual 中有但 expected 中没有
  const unknown: string[] = [];
  for (const s of actual) {
    if (!expectedSet.has(s.criterion)) {
      unknown.push(s.criterion);
    }
  }

  // 3) 重复：actual 中同一 criterion 出现多次
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const s of actual) {
    if (seen.has(s.criterion)) {
      if (!duplicates.includes(s.criterion)) {
        duplicates.push(s.criterion);
      }
    } else {
      seen.add(s.criterion);
    }
  }

  // 转成 warning 字符串。重复和未知是 FAIL（必须修复），
  // 缺是 PENDING（Judge 还没跑完）。区分状态由 complete 标志表达。
  for (const m of missing) {
    warnings.push(`${tag} semantic.${m} 未评分（PENDING）`);
  }
  for (const u of unknown) {
    warnings.push(`${tag} semantic.${u} 未在 case.semantic_criteria 中声明（FAIL）`);
  }
  for (const d of duplicates) {
    warnings.push(`${tag} semantic.${d} 重复评分 ${duplicates.length} 次（FAIL）`);
  }

  return {
    complete: missing.length === 0 && unknown.length === 0 && duplicates.length === 0,
    missing,
    unknown,
    duplicates,
    warnings,
  };
}
