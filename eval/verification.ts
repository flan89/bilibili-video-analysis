/**
 * Skill case 结构化 verification 字段。
 *
 * 取代 P0 阶段从 `forbidden_behaviors` 自然语言抽取工具引用的做法。
 * 当 skill-case 声明了 `verification` 字段时，verify 工具优先按本字段
 * 的强类型规则做确定性检查；不再声明时仍可走自然语言 fallback。
 *
 * 设计原则：
 * - 每条规则都是"可机器验证"的，不依赖自然语言解读；
 * - 字段全部 optional，未声明视为"不约束"；
 * - 时间戳 / 关键词等使用 regex 字符串，方便 skill-case 作者表达；
 * - 工具名空间与 `KNOWN_TOOL_NAMES` 对齐，未知工具名会触发警告。
 */
import { z } from "zod";

/** 允许在 verification 中出现的工具名集合。 */
export const VERIFIABLE_TOOL_NAMES = new Set([
  // M7 新增：主题发现阶段的视频搜索 Tool（CLI 名 search-videos，归一化为 search）。
  "search",
  // M8 新增：当前热门 Tool（CLI 名 popular-videos，归一化为 popular）。
  "popular",
  // M8 批次 B 新增：当前热搜 Tool（CLI 名 hot-searches，归一化为 hot-search）。
  "hot-search",
  // M8 批次 C 新增：关联推荐 Tool（CLI 名 related-videos，归一化为 related）。
  "related",
  "metadata",
  "subtitle",
  "comments",
  "danmaku",
  "video",
  "frames",
  "audio",
  "timeline",
  "cover",
]);

/**
 * skill-case 可选的结构化 verification 字段。
 * 未声明任何子字段时，verify 工具不应用本规则的任何检查。
 */
export const VerificationSchema = z
  .object({
    /** Agent 必须调用的工具集合（顺序不强制，集合语义）。 */
    mustCallTools: z.array(z.string().min(1)).default([]),
    /** Agent 不应调用的工具集合（任一出现即违规）。 */
    mustNotCallTools: z.array(z.string().min(1)).default([]),
    /** final_answer 必须匹配的所有 regex（全部命中才算通过）。 */
    requiredAnswerPatterns: z.array(z.string().min(1)).default([]),
    /** final_answer 不应匹配的所有 regex（任一命中即违规）。 */
    forbiddenAnswerPatterns: z.array(z.string().min(1)).default([]),
    /**
     * Agent 必须显式声明的 capability gap 关键词。
     * 用于确保 Agent 在能力缺失时不会偷偷降级为字幕总结。
     * 例：["ASR 未实现", "视觉 Tool 未实现"]
     */
    mustDeclareCapabilityGap: z.array(z.string().min(1)).default([]),
    /** 工具调用总次数上限；超过即视为 over-fetch。 */
    maxToolCallCount: z.number().int().positive().optional(),
    /**
     * final_answer 中必须包含的最小时间戳引用次数。
     * 用以确保内容学习类 case 真的回查到了字幕时间。
     * 粗略匹配 [startSec - endSec] 或 [MM:SS] 形式。
     */
    minTimeRangeReferences: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

/**
 * 单条结构化检查的执行结果。
 * 与 scripts/agent-run/schema.ts 的 DeterministicCheck 同形，
 * 但本文件单独定义避免循环依赖。
 */
export interface VerificationCheckResult {
  rule: string;
  passed: boolean;
  detail?: string;
}

/**
 * 弱接口：只依赖 verify 工具需要的最小字段集合。
 * 让本模块可独立于 AgentRun 的具体 Schema 测试。
 */
export interface VerifiableRun {
  caseId: string;
  toolTrace: Array<{ tool: string; outcome?: string }>;
  finalAnswer: string;
}

/**
 * 抓取 final_answer 中的时间戳引用次数。
 *
 * 兼容多种自然表达：
 * - `[43.00-47.30]`（带方括号的秒数范围）
 * - `[01:30 - 01:45]`（带方括号的 MM:SS 范围）
 * - `43.00-47.30`（裸秒数范围）
 * - `01:30 - 01:45`（裸 MM:SS 范围）
 * - `在 03:15`（单点时间戳）
 * - `段 5`（带"段"后缀的索引）
 *
 * 同范围内不重复计数；用 Set 收集命中位置以保证稳定。
 */
export function countTimeRangeReferences(answer: string): number {
  const patterns: RegExp[] = [
    // [start - end] with seconds
    /\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*\]/g,
    // [start - end] with MM:SS
    /\[\s*\d{1,2}:\d{2}(?:\.\d+)?\s*-\s*\d{1,2}:\d{2}(?:\.\d+)?\s*\]/g,
    // bare seconds range: 43.00-47.30
    // 排除作为 MM:SS 内部分数字片段（如 "01:30 - 01:45" 中的 "30 - 01"）
    /(?<![\d:.])\d{1,3}(?:\.\d+)?\s*-\s*\d{1,3}(?:\.\d+)?(?![\d:.])/g,
    // bare MM:SS range
    /\b\d{1,2}:\d{2}(?:\.\d+)?\s*-\s*\d{1,2}:\d{2}(?:\.\d+)?\b/g,
    // single MM:SS point: "在 03:15" or "03:15"
    // 用 lookbehind/lookahead 排除作为范围端点的 MM:SS（前面是 - 或 [、后面是 - 或 ]）
    /(?<![\d:.\-\[])\d{1,2}:\d{2}(?:\.\d+)?(?![\d:\-\]])/g,
    // segment index
    /段\s*\d+/g,
  ];
  const hits = new Set<string>();
  for (const p of patterns) {
    const matches = answer.match(p);
    if (matches) {
      for (const m of matches) {
        // 用 match.toLowerCase + trim 作为唯一 key，避免范围边界微小差异
        hits.add(normalizeHit(m));
      }
    }
  }
  return hits.size;
}

/**
 * 把命中字符串归一化为稳定的去重 key。
 * 去除空白、方括号、"段"后缀等格式差异，让 "[43.00-47.30]" 和
 * "43.00-47.30" 被识别为同一次引用。
 */
function normalizeHit(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]()]/g, "")
    .replace(/段(\d+)/, "$1");
}

/**
 * 对单条 Agent Run 跑结构化 verification 检查。
 * 返回一组与 DeterministicCheck 同形的结果，可由 verify 工具统一汇总。
 *
 * 注意：
 * - 工具名校验使用 VERIFIABLE_TOOL_NAMES；
 * - regex 编译失败时返回 passed=false 并报告 pattern 字符串；
 * - 全部 mustCallTools / mustNotCallTools 缺失或越界都会单独报。
 */
export function runStructuredChecks(
  run: VerifiableRun,
  verification: Verification,
): VerificationCheckResult[] {
  const results: VerificationCheckResult[] = [];
  const calledTools = new Set(run.toolTrace.map((c) => c.tool));

  // 1) mustCallTools：每个声明的工具都必须在 toolTrace 中出现。
  for (const required of verification.mustCallTools) {
    if (!VERIFIABLE_TOOL_NAMES.has(required)) {
      results.push({
        rule: `must_call_${required}`,
        passed: false,
        detail: `verification 声明了未知工具名：${required}`,
      });
      continue;
    }
    if (!calledTools.has(required)) {
      results.push({
        rule: `must_call_${required}`,
        passed: false,
        detail: `Agent 未调用 ${required}`,
      });
    } else {
      results.push({
        rule: `must_call_${required}`,
        passed: true,
      });
    }
  }

  // 2) mustNotCallTools：每个声明的工具都不能出现在 toolTrace 中。
  for (const forbidden of verification.mustNotCallTools) {
    if (!VERIFIABLE_TOOL_NAMES.has(forbidden)) {
      results.push({
        rule: `must_not_call_${forbidden}`,
        passed: false,
        detail: `verification 声明了未知工具名：${forbidden}`,
      });
      continue;
    }
    if (calledTools.has(forbidden)) {
      results.push({
        rule: `must_not_call_${forbidden}`,
        passed: false,
        detail: `Agent 不应调用 ${forbidden}，但实际调用了`,
      });
    } else {
      results.push({
        rule: `must_not_call_${forbidden}`,
        passed: true,
      });
    }
  }

  // 3) requiredAnswerPatterns：每个 regex 都必须在 final_answer 中命中。
  for (const pattern of verification.requiredAnswerPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "u");
    } catch (err) {
      results.push({
        rule: `required_answer_pattern`,
        passed: false,
        detail: `无法编译 pattern: ${pattern}（${
          err instanceof Error ? err.message : String(err)
        }）`,
      });
      continue;
    }
    if (regex.test(run.finalAnswer)) {
      results.push({ rule: `required_answer_pattern:${pattern}`, passed: true });
    } else {
      results.push({
        rule: `required_answer_pattern:${pattern}`,
        passed: false,
        detail: `final_answer 未匹配：${pattern}`,
      });
    }
  }

  // 4) forbiddenAnswerPatterns：任一 regex 命中即违规。
  for (const pattern of verification.forbiddenAnswerPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "u");
    } catch (err) {
      results.push({
        rule: `forbidden_answer_pattern`,
        passed: false,
        detail: `无法编译 pattern: ${pattern}（${
          err instanceof Error ? err.message : String(err)
        }）`,
      });
      continue;
    }
    if (regex.test(run.finalAnswer)) {
      results.push({
        rule: `forbidden_answer_pattern:${pattern}`,
        passed: false,
        detail: `final_answer 命中了禁止 pattern：${pattern}`,
      });
    } else {
      results.push({ rule: `forbidden_answer_pattern:${pattern}`, passed: true });
    }
  }

  // 5) mustDeclareCapabilityGap：数组中**任一**关键词在 final_answer 中出现
  // 即视为"已声明能力缺口"。这样 case 作者可以列出多种等价措辞，
  // 不强制 Agent 使用某种特定表达。
  if (verification.mustDeclareCapabilityGap.length > 0) {
    const hit = verification.mustDeclareCapabilityGap.find((kw) =>
      run.finalAnswer.includes(kw),
    );
    if (hit) {
      results.push({
        rule: `must_declare_capability_gap`,
        passed: true,
        detail: `命中：${hit}`,
      });
    } else {
      results.push({
        rule: `must_declare_capability_gap`,
        passed: false,
        detail: `final_answer 未包含以下任何 keyword：${verification.mustDeclareCapabilityGap.join(" / ")}`,
      });
    }
  }

  // 6) maxToolCallCount：超过上限即违规。
  if (
    verification.maxToolCallCount !== undefined &&
    run.toolTrace.length > verification.maxToolCallCount
  ) {
    results.push({
      rule: "max_tool_call_count",
      passed: false,
      detail: `实际调用 ${run.toolTrace.length} 次，超过上限 ${verification.maxToolCallCount}`,
    });
  } else if (verification.maxToolCallCount !== undefined) {
    results.push({
      rule: "max_tool_call_count",
      passed: true,
    });
  }

  // 7) minTimeRangeReferences：低于下限即违规。
  if (verification.minTimeRangeReferences !== undefined) {
    const actual = countTimeRangeReferences(run.finalAnswer);
    if (actual < verification.minTimeRangeReferences) {
      results.push({
        rule: "min_time_range_references",
        passed: false,
        detail: `final_answer 中时间戳引用 ${actual} 次，少于下限 ${verification.minTimeRangeReferences}`,
      });
    } else {
      results.push({
        rule: "min_time_range_references",
        passed: true,
      });
    }
  }

  return results;
}
