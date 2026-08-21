/**
 * eval/verification.ts 单元测试。
 *
 * 覆盖：mustCallTools / mustNotCallTools / requiredAnswerPatterns /
 * forbiddenAnswerPatterns / mustDeclareCapabilityGap / maxToolCallCount /
 * minTimeRangeReferences / 未知工具名 / regex 编译失败。
 */
import { describe, expect, it } from "vitest";
import {
  VerificationSchema,
  countTimeRangeReferences,
  runStructuredChecks,
  type VerifiableRun,
} from "../../eval/verification.js";

function makeRun(overrides: Partial<VerifiableRun> = {}): VerifiableRun {
  return {
    caseId: "test-case",
    toolTrace: [
      { tool: "metadata", outcome: "success" },
      { tool: "subtitle", outcome: "success" },
    ],
    finalAnswer:
      "作者在 [43.00-47.30] 提出了核心结论：…\n依据 03:15 段，…",
    ...overrides,
  };
}

describe("countTimeRangeReferences", () => {
  it("兼容方括号秒数范围", () => {
    expect(countTimeRangeReferences("在 [43.00-47.30]")).toBe(1);
    expect(countTimeRangeReferences("[10.5-20.5] 与 [30-40]")).toBe(2);
  });

  it("兼容裸秒数范围", () => {
    expect(countTimeRangeReferences("43.00-47.30 出现")).toBe(1);
  });

  it("兼容 MM:SS 形式", () => {
    expect(countTimeRangeReferences("在 03:15")).toBe(1);
    expect(countTimeRangeReferences("[01:30 - 01:45]")).toBe(1);
  });

  it("相同范围不重复计数", () => {
    expect(countTimeRangeReferences("[43.00-47.30] 又 [43.00-47.30]")).toBe(1);
  });

  it("空字符串返回 0", () => {
    expect(countTimeRangeReferences("")).toBe(0);
    expect(countTimeRangeReferences("没有时间戳的纯文字")).toBe(0);
  });
});

describe("VerificationSchema", () => {
  it("默认所有数组字段为空对象", () => {
    const v = VerificationSchema.parse({});
    expect(v.mustCallTools).toEqual([]);
    expect(v.mustNotCallTools).toEqual([]);
    expect(v.requiredAnswerPatterns).toEqual([]);
    expect(v.forbiddenAnswerPatterns).toEqual([]);
    expect(v.mustDeclareCapabilityGap).toEqual([]);
  });

  it("未知字段被 strict 拒绝", () => {
    expect(() =>
      VerificationSchema.parse({ unknownField: "x" }),
    ).toThrow();
  });

  it("maxToolCallCount 必须是正整数", () => {
    expect(() =>
      VerificationSchema.parse({ maxToolCallCount: 0 }),
    ).toThrow();
    expect(() =>
      VerificationSchema.parse({ maxToolCallCount: 2.5 }),
    ).toThrow();
    expect(VerificationSchema.parse({ maxToolCallCount: 3 }).maxToolCallCount).toBe(3);
  });
});

describe("runStructuredChecks - 工具调用", () => {
  it("mustCallTools：全部调用则通过", () => {
    const run = makeRun();
    const v = VerificationSchema.parse({
      mustCallTools: ["metadata", "subtitle"],
    });
    const results = runStructuredChecks(run, v);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("mustCallTools：缺一即失败", () => {
    const run = makeRun({ toolTrace: [{ tool: "metadata", outcome: "success" }] });
    const v = VerificationSchema.parse({ mustCallTools: ["metadata", "subtitle"] });
    const results = runStructuredChecks(run, v);
    const failed = results.filter((r) => !r.passed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.rule).toBe("must_call_subtitle");
  });

  it("mustNotCallTools：未调用则通过，调用则失败", () => {
    const ok = makeRun();
    const v = VerificationSchema.parse({ mustNotCallTools: ["comments", "danmaku"] });
    expect(runStructuredChecks(ok, v).every((r) => r.passed)).toBe(true);

    const bad = makeRun({
      toolTrace: [
        { tool: "metadata", outcome: "success" },
        { tool: "comments", outcome: "success" },
      ],
    });
    const results = runStructuredChecks(bad, v);
    const failed = results.find((r) => r.rule === "must_not_call_comments");
    expect(failed?.passed).toBe(false);
  });

  it("未知工具名：verification 报 passed=false 并提示", () => {
    const run = makeRun({
      toolTrace: [{ tool: "future-tool", outcome: "success" }],
    });
    const v = VerificationSchema.parse({ mustCallTools: ["future-tool"] });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => !r.passed);
    expect(failed?.detail).toMatch(/未知工具名/);
  });
});

describe("runStructuredChecks - 答案内容", () => {
  it("requiredAnswerPatterns：全部命中则通过", () => {
    const run = makeRun({ finalAnswer: "作者在 43.00-47.30 提出了核心结论。" });
    const v = VerificationSchema.parse({
      requiredAnswerPatterns: ["核心结论", "\\d+\\.\\d+-\\d+\\.\\d+"],
    });
    expect(runStructuredChecks(run, v).every((r) => r.passed)).toBe(true);
  });

  it("requiredAnswerPatterns：缺一即失败", () => {
    const run = makeRun({ finalAnswer: "没有匹配" });
    const v = VerificationSchema.parse({ requiredAnswerPatterns: ["必须含此", "必须含彼"] });
    const results = runStructuredChecks(run, v);
    expect(results.filter((r) => !r.passed)).toHaveLength(2);
  });

  it("forbiddenAnswerPatterns：任一命中即失败", () => {
    const run = makeRun({ finalAnswer: "核心观点是 X" });
    const v = VerificationSchema.parse({
      forbiddenAnswerPatterns: ["核心观点是", "作者认为"],
    });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => !r.passed);
    expect(failed?.rule).toMatch(/^forbidden_answer_pattern/);
  });

  it("regex 编译失败：返回 passed=false 并报告 pattern", () => {
    const run = makeRun();
    const v = VerificationSchema.parse({ requiredAnswerPatterns: ["[invalid"] });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => !r.passed);
    expect(failed?.detail).toMatch(/无法编译 pattern/);
  });
});

describe("runStructuredChecks - capability gap 声明", () => {
  it("任一 keyword 命中即通过", () => {
    const run = makeRun({
      finalAnswer:
        "ASR 能力尚未实现。当前可用的 transcript 数据源只有官方字幕这一种。",
    });
    const v = VerificationSchema.parse({
      mustDeclareCapabilityGap: ["ASR 未实现", "ASR 能力尚未实现", "能力缺口"],
    });
    const results = runStructuredChecks(run, v);
    const passed = results.find((r) => r.rule === "must_declare_capability_gap");
    expect(passed?.passed).toBe(true);
  });

  it("所有 keyword 都不命中则失败", () => {
    const run = makeRun({ finalAnswer: "无关内容" });
    const v = VerificationSchema.parse({
      mustDeclareCapabilityGap: ["ASR 未实现", "能力缺口"],
    });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => r.rule === "must_declare_capability_gap");
    expect(failed?.passed).toBe(false);
  });

  it("空数组时不产生检查结果", () => {
    const run = makeRun();
    const v = VerificationSchema.parse({ mustDeclareCapabilityGap: [] });
    const results = runStructuredChecks(run, v);
    expect(results.find((r) => r.rule.startsWith("must_declare_capability_gap"))).toBeUndefined();
  });
});

describe("runStructuredChecks - 工具调用次数与时间戳", () => {
  it("maxToolCallCount：超过上限即失败", () => {
    const run = makeRun({
      toolTrace: [
        { tool: "metadata", outcome: "success" },
        { tool: "subtitle", outcome: "success" },
        { tool: "metadata", outcome: "success" },
      ],
    });
    const v = VerificationSchema.parse({ maxToolCallCount: 2 });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => r.rule === "max_tool_call_count");
    expect(failed?.passed).toBe(false);
  });

  it("minTimeRangeReferences：低于下限即失败", () => {
    const run = makeRun({ finalAnswer: "没有时间戳的纯文字" });
    const v = VerificationSchema.parse({ minTimeRangeReferences: 1 });
    const results = runStructuredChecks(run, v);
    const failed = results.find((r) => r.rule === "min_time_range_references");
    expect(failed?.passed).toBe(false);
  });

  it("minTimeRangeReferences：达到下限即通过", () => {
    const run = makeRun({ finalAnswer: "在 [43.00-47.30] 和 03:15 都有引用" });
    const v = VerificationSchema.parse({ minTimeRangeReferences: 1 });
    const results = runStructuredChecks(run, v);
    const passed = results.find((r) => r.rule === "min_time_range_references");
    expect(passed?.passed).toBe(true);
  });
});
