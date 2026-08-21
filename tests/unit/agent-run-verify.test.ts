/**
 * verifyAgentRuns 行为测试。
 *
 * 通过 fixture 覆盖三类场景：
 * 1) 正常 case：能被加载、计算 summaries、出现 missing case id；
 * 2) missing 时 final_answer 含具体观点 → 触发 failure-honesty 警告；
 * 3) 调用了 skill-case 不应默认调用的工具 → 触发 over-fetch 警告。
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAgentRuns } from "../../eval/verify.js";
import { AgentRunSchema, type AgentRun } from "../../eval/schema.js";

const TMP = join(process.cwd(), "tests", "_tmp_agent_runs");

// 用单调递增时间戳让 latestByCase 正确选最新
let writeSeq = 0;
const nextRecordedAt = (): string => {
  writeSeq += 1;
  // 2026-01-01T00:00:00Z 起始 + 序号秒
  return new Date(Date.UTC(2026, 0, 1, 0, 0, writeSeq)).toISOString();
};

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function writeRun(filename: string, run: AgentRun): Promise<void> {
  // 测试 fixture 默认按 demo_fixture 处理; AgentRunSchema 有 default, 这里显式设保证分类清晰
  const withExe: AgentRun = {
    execution: "demo_fixture",
    ...run,
  };
  const withTimestamp: AgentRun = { ...withExe, recordedAt: nextRecordedAt() };
  const validated = AgentRunSchema.parse(withTimestamp);
  await writeFile(join(TMP, filename), JSON.stringify(validated, null, 2), "utf8");
}

describe("verifyAgentRuns", () => {
  it("空目录：total=0 且 missingCaseIds 覆盖全部 skill-cases", async () => {
    const result = await verifyAgentRuns({ directory: TMP });
    expect(result.total).toBe(0);
    // skill-cases.json 当前 10 条，全部 missing
    expect(result.missingCaseIds.length).toBeGreaterThanOrEqual(10);
  });

  it("正常 content-summary run：被识别、allPassed=true、无警告", async () => {
    await writeRun("content-summary.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "帮我把这个视频讲明白",
      toolTrace: [
        {
          tool: "metadata",
          input: { video: "BV1" },
          output: {},
          outcome: "success",
        },
        {
          tool: "subtitle",
          input: { video: "BV1" },
          output: { complete: true },
          outcome: "success",
        },
      ],
      finalAnswer: "作者在 03:15 提出了核心结论。",
      evaluation: {
        deterministic: [{ rule: "must_call_subtitle", passed: true }],
        // 补齐 semantic 评分让完整性检查通过
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者与推断区分", score: 0.95 },
        ],
        summary: "通过",
      },
    });

    const result = await verifyAgentRuns({ directory: TMP });
    expect(result.summaries.find((s) => s.caseId === "content-summary")).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it("content-summary 调用 comments：触发 must_not_call_comments 警告", async () => {
    await writeRun("content-summary-overfetch.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "帮我把这个视频讲明白",
      toolTrace: [
        { tool: "subtitle", input: {}, output: {}, outcome: "success" },
        { tool: "comments", input: {}, output: {}, outcome: "success" },
      ],
      finalAnswer: "作者讲了……",
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    // content-summary 在 skill-cases.json 中声明了结构化 verification，
    // verify 工具优先用结构化规则触发 must_not_call_comments 警告。
    expect(warningTexts).toMatch(/must_not_call_comments/);
    expect(warningTexts).toMatch(/comments/);
  });

  it("outcome=failed 时 final_answer 含「作者认为/视频讲的是/总结一下」 → 触发虚构警告", async () => {
    await writeRun("content-summary-failed-honesty.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "这个视频主要讲了哪些观点？",
      toolTrace: [
        { tool: "subtitle", input: {}, output: {}, outcome: "failed" },
      ],
      finalAnswer: "作者认为这是关于……的视频；总结一下讲的是 AI 的能力。",
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    expect(warningTexts).toMatch(/虚构结果/);
  });

  it("outcome=missing 时 final_answer 不应含具体观点，但本测试故意违反", async () => {
    // missing 同样应触发诚实性检查
    await writeRun("subtitle-missing-bad.json", {
      caseId: "subtitle-missing",
      category: "subtitle_missing",
      prompt: "帮我提炼这个视频",
      toolTrace: [
        { tool: "subtitle", input: {}, output: {}, outcome: "missing" },
      ],
      finalAnswer: "作者的核心观点是：……；视频讲的是 Agent 设计。",
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    expect(warningTexts).toMatch(/虚构结果/);
  });

  it("未知工具名触发警告", async () => {
    await writeRun("content-summary-unknown.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "test",
      toolTrace: [
        { tool: "future-tool", input: {}, output: {}, outcome: "success" },
      ],
      finalAnswer: "test",
    });

    const result = await verifyAgentRuns({ directory: TMP });
    expect(result.warnings.join("\n")).toMatch(/未知工具：future-tool/);
  });

  it("semantic 缺漏触发 PENDING 警告，三段 status 显式 pending 不算 PASS", async () => {
    await writeRun("content-summary-incomplete.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "帮我把这个视频讲明白",
      toolTrace: [{ tool: "subtitle", input: {}, output: {}, outcome: "success" }],
      finalAnswer: "作者在 03:15 提出了核心结论。",
      // 只评了 1 个 criterion（缺"时间锚定"和"作者与推断区分"）
      evaluation: {
        deterministic: [],
        semantic: [{ criterion: "中心性归纳", score: 0.9 }],
      },
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    expect(warningTexts).toMatch(/时间锚定.*PENDING/);
    expect(warningTexts).toMatch(/作者与推断区分.*PENDING/);
    // PENDING 必须显式标出：不能算 passed（避免验收统计虚高），也不算 failed
    const summary = result.summaries.find((s) => s.caseId === "content-summary");
    expect(summary?.semanticStatus).toBe("pending");
    expect(summary?.overallStatus).toBe("pending");
    expect(summary?.deterministicStatus).toBe("passed");
    expect(summary?.allPassed).toBe(false);
  });

  it("semantic 出现未知 criterion 触发 FAIL（CODEX §2.2）", async () => {
    await writeRun("content-summary-unknown-criterion.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "test",
      toolTrace: [{ tool: "subtitle", input: {}, output: {}, outcome: "success" }],
      finalAnswer: "作者在 03:15 提出了核心结论。",
      // 包含 case 未声明的 criterion
      evaluation: {
        deterministic: [],
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者与推断区分", score: 0.95 },
          { criterion: "未知维度", score: 0.8 },
        ],
      },
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    expect(warningTexts).toMatch(/未知维度.*FAIL/);
    const summary = result.summaries.find((s) => s.caseId === "content-summary");
    // 未知 criterion 触发 FAIL
    expect(summary?.semanticStatus).toBe("failed");
    expect(summary?.overallStatus).toBe("failed");
    expect(summary?.allPassed).toBe(false);
  });

  it("semantic 重复 criterion 触发 FAIL（CODEX §2.2）", async () => {
    await writeRun("content-summary-duplicate.json", {
      caseId: "content-summary",
      category: "content_summary",
      prompt: "test",
      toolTrace: [{ tool: "subtitle", input: {}, output: {}, outcome: "success" }],
      finalAnswer: "作者在 03:15 提出了核心结论。",
      evaluation: {
        deterministic: [],
        semantic: [
          { criterion: "中心性归纳", score: 0.9 },
          { criterion: "中心性归纳", score: 0.85 }, // 重复
          { criterion: "时间锚定", score: 0.95 },
          { criterion: "作者与推断区分", score: 0.95 },
        ],
      },
    });

    const result = await verifyAgentRuns({ directory: TMP });
    const warningTexts = result.warnings.join("\n");
    expect(warningTexts).toMatch(/中心性归纳.*重复/);
    const summary = result.summaries.find((s) => s.caseId === "content-summary");
    expect(summary?.semanticStatus).toBe("failed");
    expect(summary?.overallStatus).toBe("failed");
    expect(summary?.allPassed).toBe(false);
  });
});
