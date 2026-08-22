import { z } from "zod";
import { DataKindSchema } from "./acquisition.js";

/** 与 SKILL.md 中的顶层 Intent 保持一致。 */
export const TaskIntentSchema = z.enum([
  "content_learn",
  "visual_decode",
  "audience_insight",
  "market_research",
  /** M7 (V2) 新增: 从主题或问题出发，先发现候选视频再研究多个视频。 */
  "topic_research",
  "overview",
]);
export type TaskIntent = z.infer<typeof TaskIntentSchema>;

/** 分析深度：只影响投入规模，不应突破 Intent 的业务边界。 */
export const TaskDepthSchema = z.enum(["quick", "standard", "deep"]);
export type TaskDepth = z.infer<typeof TaskDepthSchema>;

/** 是否需要在真正执行重型数据获取前先向用户澄清。 */
export const ClarificationSchema = z.object({
  /** true 表示当前请求不应直接进入重型执行。 */
  needed: z.boolean(),
  /** 需要澄清时给用户的一条简短问题；不需要时为 null。 */
  question: z.string().nullable().default(null),
  /** 为什么需要澄清，主要用于调试和路由评估。 */
  reason: z.string().nullable().default(null),
});
export type Clarification = z.infer<typeof ClarificationSchema>;

/**
 * Fallback 只描述“条件 → 动作”，不在模型层绑定具体函数。
 * 例如后续可由 Agent 选择 FunASR Tool，而不是在这里写死实现。
 */
export const FallbackRuleSchema = z.object({
  /** 触发降级/替代路径的自然语言条件。 */
  if: z.string().min(1),
  /** 条件满足后建议执行的动作。 */
  then: z.string().min(1),
});
export type FallbackRule = z.infer<typeof FallbackRuleSchema>;

/** 路由器生成的数据获取计划。 */
export const DataPlanSchema = z.object({
  /** 完成当前任务必须获取的数据种类。 */
  required: z.array(DataKindSchema).default([]),
  /** 能提升结果但不是任务成立必要条件的数据种类。 */
  optional: z.array(DataKindSchema).default([]),
  /** 这里保留开放字符串，以兼容 full_comments / market_research_data 等策略性禁用项。 */
  avoid_by_default: z.array(z.string()).default([]),
  /** 必要数据不可用时的候选降级路径。 */
  fallbacks: z.array(FallbackRuleSchema).default([]),
});
export type DataPlan = z.infer<typeof DataPlanSchema>;

/**
 * TaskPlan 刻意保留 snake_case，与现有 Skill JSON 契约一致，
 * 路由器输出可以直接进行 Zod 校验，不需要再做命名转换。
 */
export const TaskPlanSchema = z.object({
  /** 用户本次真正要完成的自然语言目标；应尽量保留原意。 */
  objective: z.string().min(1),

  /** 澄清型请求允许暂时为 null。 */
  primary_intent: TaskIntentSchema.nullable(),
  /** 只有确实改变数据或分析方式时才增加辅助 Intent。 */
  secondary_intents: z.array(TaskIntentSchema).default([]),

  /** Focus 是开放集合，不做 enum，允许 LLM 为新场景生成新标签。 */
  focus: z.array(z.string().min(1)).default([]),
  /** 尚未确认目标时 depth 可为空。 */
  depth: TaskDepthSchema.nullable(),

  /** 澄清决策。 */
  clarification: ClarificationSchema,
  /** 完成当前任务所需的数据计划。 */
  data_plan: DataPlanSchema,
  /** 记录非显而易见的路由理由，便于测试和后续优化。 */
  routing_notes: z.array(z.string()).default([]),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
