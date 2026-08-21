/**
 * Agent Run 数据模型。
 *
 * 让启用了本 Skill 的 Agent 在跑完一个 case 后，把 prompt、
 * 工具调用 trace、最终回答和人工/半自动评测结果落盘成 JSON，方便后续：
 *
 * 1. 离线回归比较（Tool Trace 一致性、是否错误调用重型 Tool）；
 * 2. 持续积累端到端行为数据；
 * 3. 记录真实安装环境中的最小验证结果。
 *
 * 设计原则：
 * - Tool 名称、prompt 和最终回答按原文保存，不做语义改写；
 * - 评测结果（evaluation）允许人工或半自动 LLM Judge 写入；
 * - 文件名强制使用 stable case id，方便和 tests/skill-cases.json 对应；
 * - 不内嵌模型调用，纯数据载体。
 */
import { z } from "zod";
import { IsoDateTimeSchema } from "../scripts/models/common.js";

/**
 * 单条 Tool 调用记录。
 * 记录 Agent 在该 case 中调用某个 Tool 的输入与输出概要，
 * 用于后续做 Trace 级别的确定性断言。
 */
export const ToolCallRecordSchema = z.object({
  /** 调用工具的稳定名称，例如 subtitle、metadata、comments。 */
  tool: z.string().min(1),
  /** 工具输入的关键参数摘要（例如 bvid、page、language）。 */
  input: z.record(z.unknown()).default({}),
  /** 工具返回的关键字段摘要，文本型结果可放 result 字符串。 */
  output: z.record(z.unknown()).default({}),
  /** 工具产出的 outcome（success / selection_required / missing / partial / failed）。 */
  outcome: z
    .enum(["success", "selection_required", "missing", "partial", "failed"])
    .default("success"),
  /** 调用时间，按 ISO 8601 记录，方便后续做耗时分析。 */
  calledAt: IsoDateTimeSchema.optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

/**
 * 确定性行为断言的执行结果。
 * mustCall / mustNotCall 等规则可由 verify CLI 写回 evaluation。
 */
export const DeterministicCheckSchema = z.object({
  /** 规则标识，例如 must_call_subtitle、must_not_call_comments。 */
  rule: z.string().min(1),
  /** 是否通过。 */
  passed: z.boolean(),
  /** 失败或通过时的可读说明，便于人工 review。 */
  detail: z.string().optional(),
});
export type DeterministicCheck = z.infer<typeof DeterministicCheckSchema>;

/**
 * 单条 Agent Run 记录。
 * 对应 tests/skill-cases.json 中的一条 case，或人工新加的探索 case。
 */
export const AgentRunSchema = z
  .object({
    /** 关联的 case id，与 tests/skill-cases.json 中的 id 对齐。 */
    caseId: z.string().min(1),
    /** 该 case 的 category，可与 skill-cases.json 对应。 */
    category: z.string().min(1).optional(),
    /** 实际下发给 Agent 的用户 Prompt（已替换 {{video}} 等占位符）。 */
    prompt: z.string().min(1),
    /**
     * Agent Run 类别, 区分真实 Agent 端到端跑 还是 fixture 演示:
     * - real_agent: 真实 Agent 加载 Skill → 真实 Tool 调用 → 用户回答
     * - demo_fixture: 协议演示 fixture (含 {{video}} 占位符 / BV_FIXTURE_* / 注入确定性 Tool 输出), 不是真实 E2E
     *
     * 默认 demo_fixture 是保守做法: 新增 fixture 不会被默认算作 real_agent,
     * 防止验收报告把 demo 跟 real_agent 混算.
     */
    execution: z
      .enum(["real_agent", "demo_fixture"])
      .default("demo_fixture")
      .optional(),
    /** Agent 加载并启用的 Skill 标识，用于排查不同环境下的偏差。 */
    skillVersion: z.string().min(1).optional(),
    /** 工具调用 trace，按调用顺序记录。 */
    toolTrace: z.array(ToolCallRecordSchema).default([]),
    /** Agent 最终面向用户的回答原文。 */
    finalAnswer: z.string().min(1),
    /** 记录时间，按 ISO 8601 带时区字符串保存。 */
    recordedAt: IsoDateTimeSchema.optional(),
    /** 评测结果（人工 / LLM Judge / 确定性脚本皆可写入）。 */
    evaluation: z
      .object({
        deterministic: z.array(DeterministicCheckSchema).default([]),
        semantic: z
          .array(
            z.object({
              criterion: z.string().min(1),
              score: z.number().min(0).max(1),
              note: z.string().optional(),
            }),
          )
          .optional()
          .default([]),
        summary: z.string().optional(),
      })
      .optional(),
    /** 备注：例如运行环境、Agent 平台或工具替代说明。 */
    notes: z.string().optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;

/**
 * 验证工具扫描到的最小目录记录，便于汇报每个 case 的最新状态。
 *
 * 三段 status 拆分（确定性 / 语义 / 综合）— 避免 Semantic PENDING 被算成整体 PASS。
 * `allPassed` 字段保留为 `overallStatus === "passed"` 的便捷别名，
 * 历史调用方不需要立刻切换到 status 字段。
 */
export const AgentRunSummarySchema = z.object({
  caseId: z.string().min(1),
  runCount: z.number().int().nonnegative(),
  latestRecordedAt: IsoDateTimeSchema.optional(),
  /** 工具调用 / 结构化规则层是否通过（mustCall / mustNotCall / over-fetch / failure-honesty 等）。 */
  deterministicStatus: z.enum(["passed", "failed"]),
  /** 语义评分层状态：case 未声明 semantic_criteria 时为 not_applicable；Judge 还没跑完为 pending。 */
  semanticStatus: z.enum(["passed", "failed", "pending", "not_applicable"]),
  /** 综合状态：deterministic / semantic 任一失败 → failed；semantic pending → pending；否则 passed。 */
  overallStatus: z.enum(["passed", "failed", "pending"]),
  /** 向后兼容别名，等价于 `overallStatus === "passed"`。 */
  allPassed: z.boolean(),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
