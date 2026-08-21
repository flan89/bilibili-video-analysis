/**
 * eval/semantic-completeness.ts 单元测试。
 *
 * 覆盖三类完整性检查（CODEX §2.2）：
 * 1) 缺：expected 中有但 actual 中没有 → PENDING；
 * 2) 未知：actual 中有但 expected 中没有 → FAIL；
 * 3) 重复：actual 中同一 criterion 多次 → FAIL。
 */
import { describe, expect, it } from "vitest";
import {
  checkSemanticCriteriaCompleteness,
  type MinimalAgentRun,
  type MinimalSkillCase,
} from "../../eval/semantic-completeness.js";
import type { SemanticCriterion } from "../../eval/semantic-judge.js";

const CRITERIA: SemanticCriterion[] = [
  { name: "中心性归纳", description: "d1", threshold: 0.7 },
  { name: "时间锚定", description: "d2", threshold: 0.7 },
  { name: "作者区分", description: "d3", threshold: 0.6 },
];

function makeCase(): MinimalSkillCase {
  return { id: "test-case", semantic_criteria: CRITERIA };
}

function makeRun(overrides: Partial<MinimalAgentRun> = {}): MinimalAgentRun {
  return {
    caseId: "test-case",
    evaluation: {
      semantic: [
        { criterion: "中心性归纳", score: 0.9 },
        { criterion: "时间锚定", score: 0.95 },
        { criterion: "作者区分", score: 0.95 },
      ],
    },
    ...overrides,
  };
}

describe("checkSemanticCriteriaCompleteness - 完整覆盖", () => {
  it("所有 expected 都被评分，complete=true", () => {
    const result = checkSemanticCriteriaCompleteness(makeRun(), makeCase());
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkSemanticCriteriaCompleteness - 缺", () => {
  it("缺 1 个 criterion：complete=false，missing 含该 criterion", () => {
    const run = makeRun({
      evaluation: {
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          // 缺"作者区分"
        ],
      },
    });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["作者区分"]);
    expect(result.unknown).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.warnings.some((w) => w.includes("作者区分") && w.includes("PENDING"))).toBe(
      true,
    );
  });

  it("缺全部 criterion（run 没跑过 Judge）：missing 含全部", () => {
    const run = makeRun({ evaluation: { semantic: [] } });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["中心性归纳", "时间锚定", "作者区分"]);
  });
});

describe("checkSemanticCriteriaCompleteness - 未知", () => {
  it("run 评分了 case 未声明的 criterion：complete=false，unknown 含该 criterion", () => {
    const run = makeRun({
      evaluation: {
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者区分", score: 0.95 },
          { criterion: "未知维度", score: 0.8 },
        ],
      },
    });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    expect(result.unknown).toEqual(["未知维度"]);
    expect(result.warnings.some((w) => w.includes("未知维度") && w.includes("FAIL"))).toBe(
      true,
    );
  });
});

describe("checkSemanticCriteriaCompleteness - 重复", () => {
  it("同一 criterion 评分 2 次：complete=false，duplicates 含该 criterion", () => {
    const run = makeRun({
      evaluation: {
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者区分", score: 0.95 },
          { criterion: "中心性归纳", score: 0.85 }, // 重复
        ],
      },
    });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    expect(result.duplicates).toEqual(["中心性归纳"]);
    expect(result.warnings.some((w) => w.includes("中心性归纳") && w.includes("重复"))).toBe(
      true,
    );
  });

  it("同一 criterion 评分 3 次：duplicates 仍只含 1 次（去重）", () => {
    const run = makeRun({
      evaluation: {
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者区分", score: 0.95 },
          { criterion: "中心性归纳", score: 0.85 },
          { criterion: "中心性归纳", score: 0.7 },
        ],
      },
    });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.duplicates).toEqual(["中心性归纳"]);
  });
});

describe("checkSemanticCriteriaCompleteness - 混合", () => {
  it("缺 + 未知 + 重复同时出现：三类都报告", () => {
    const run = makeRun({
      evaluation: {
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "中心性归纳", score: 0.85 }, // 重复
          { criterion: "未知维度", score: 0.5 }, // 未知
          // 缺：时间锚定、作者区分
        ],
      },
    });
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    // missing 按 expected 顺序产出
    expect(result.missing).toEqual(["时间锚定", "作者区分"]);
    expect(result.unknown).toEqual(["未知维度"]);
    expect(result.duplicates).toEqual(["中心性归纳"]);
    // 警告数量 = 2 (missing) + 1 (unknown) + 1 (duplicates) = 4
    expect(result.warnings.length).toBe(4);
  });
});

describe("checkSemanticCriteriaCompleteness - 边界", () => {
  it("case 未声明 semantic_criteria 且 run 也没评分：complete=true（无内容可校验）", () => {
    const result = checkSemanticCriteriaCompleteness(
      makeRun({ evaluation: { semantic: [] } }),
      { id: "no-criteria-case" },
    );
    expect(result.complete).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("case 未声明 semantic_criteria 但 run 评分了：unknown 报告所有", () => {
    const result = checkSemanticCriteriaCompleteness(
      makeRun(),
      { id: "no-criteria-case" },
    );
    expect(result.complete).toBe(false);
    expect(result.unknown.length).toBe(3);
  });

  it("run 没有 evaluation.semantic 字段：视为空", () => {
    const run: MinimalAgentRun = { caseId: "test-case" };
    const result = checkSemanticCriteriaCompleteness(run, makeCase());
    expect(result.complete).toBe(false);
    expect(result.missing.length).toBe(3);
  });
});
