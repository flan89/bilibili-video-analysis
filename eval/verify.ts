/**
 * 验证已落盘的 Agent Run 文件。
 *
 * 主要职责：
 * - 扫描 tests/agent-runs/ 中的所有 Agent Run 文件；
 * - 校验 Schema 合法性；
 * - 与 tests/skill-cases.json 做最小对照：
 *   - 找到匹配的 case id 时报告 category / tool_outcome；
 *   - 报告"该 case 没有任何 Agent Run 记录"，便于跟踪未跑过的 case；
 * - 跑硬性确定性检查，避免 Agent 偷偷 over-fetch 或失败时虚构结果：
 *   - **结构化规则优先**（P1-1）：当 skill-case 声明了 `verification` 字段时，
 *     用强类型规则（mustCallTools / mustNotCallTools / requiredAnswerPatterns
 *     / forbiddenAnswerPatterns / mustDeclareCapabilityGap / maxToolCallCount
 *     / minTimeRangeReferences）做精确判定；
 *   - **自然语言 fallback**：当 skill-case 未声明 verification 字段时，
 *     仍从 `forbidden_behaviors` 抽取工具引用 + 旧的"失败时含具体观点"检查。
 *
 * 本模块不做语义评分，语义判断由独立评估流程完成。
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentRunSchema,
  type AgentRun,
  type AgentRunSummary,
} from "./schema.js";
import { runStructuredChecks, type VerificationCheckResult } from "./verification.js";
import { loadSkillCases, type SkillCase } from "./verify-helper.js";
import { checkSemanticCriteriaCompleteness } from "./semantic-completeness.js";

export interface VerifyAgentRunsOptions {
  /** Agent Run 目录，默认 tests/agent-runs。 */
  directory?: string;
  /** skill-cases.json 路径，默认 tests/skill-cases.json。 */
  skillCasesPath?: string;
}

export interface VerifyAgentRunsResult {
  total: number;
  passed: number;
  failed: number;
  /** Semantic PENDING 的 case 数（不能算入 passed，也不算 failed）。 */
  pending: number;
  summaries: AgentRunSummary[];
  /** 未跑过的 case id 列表（与 skill-cases.json 对照）。 */
  missingCaseIds: string[];
  /** 重要警告（例如 over-fetch / 失败时回答含具体观点）。 */
  warnings: string[];
  /** 待跑 LLM Judge 的 case（已有 Agent Run 且 case 声明了 semantic_criteria） */
  pendingSemanticJudge: Array<{ caseId: string; criteriaCount: number }>;
}

/** 工具名归一化：search / popular / hot-search / related / metadata / subtitle / comments / danmaku / video / frames / audio / timeline / cover。 */
const KNOWN_TOOL_NAMES = new Set([
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
 * 把字符串里的工具引用抽取出来（仅自然语言 fallback 使用）。
 * 兼容 "调用 subtitle Tool" / "获取 metadata" / "弹幕数据" 等说法。
 */
function extractToolMentions(text: string): Set<string> {
  const found = new Set<string>();
  for (const name of KNOWN_TOOL_NAMES) {
    const aliasMap: Record<string, RegExp[]> = {
      search: [/\bsearch(-videos)?\b/i, /搜索\s*Tool/, /搜索工具/, /视频搜索/],
      popular: [/\bpopular(-videos)?\b/i, /热门\s*Tool/, /热门工具/, /当前热门/],
      "hot-search": [/\bhot(-|_)?search(es)?\b/i, /热搜\s*Tool/, /热搜工具/, /热搜词/],
      related: [/\brelated(-videos)?\b/i, /关联\s*Tool/, /关联工具/, /关联推荐/, /关联视频/],
      metadata: [/\bmetadata\b/i, /元信息/, /视频元信息/],
      subtitle: [/\bsubtitle\b/i, /官方字幕/, /字幕\s*Tool/, /字幕工具/],
      comments: [/\bcomments?\b/i, /评论/],
      danmaku: [/\bdanmaku\b/i, /弹幕/],
      video: [/\bvideo\b/i, /视频画面/, /下载视频/, /视频文件/],
      frames: [/\bframes?\b/i, /关键帧/, /抽帧/, /截帧/],
      audio: [/\baudio\b/i, /音频/],
      timeline: [/\btimeline\b/i, /时间线/, /时间轴/],
      cover: [/\bcover\b/i, /封面/],
    };
    const patterns = aliasMap[name] ?? [new RegExp(`\\b${name}\\b`, "i")];
    if (patterns.some((p) => p.test(text))) {
      found.add(name);
    }
  }
  return found;
}


/**
 * 加载 skill-cases.json 全部内容，建立 id → case 的索引。
 */
/**
 * 加载所有 Agent Run 文件。
 */
async function loadAgentRuns(directory: string): Promise<AgentRun[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const runs: AgentRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readFile(join(directory, entry), "utf8");
    const parsed = AgentRunSchema.parse(JSON.parse(raw));
    runs.push(parsed);
  }
  return runs;
}

/**
 * 把 VerificationCheckResult 列表转换为 warnings 字符串列表。
 * 仅 failed 项被报告，避免噪音。
 */
function checksToWarnings(
  results: VerificationCheckResult[],
  caseId: string,
  tag: string,
): string[] {
  return results
    .filter((r) => !r.passed)
    .map(
      (r) =>
        `[case ${caseId}${tag}] verification.${r.rule} 未通过${r.detail ? `：${r.detail}` : ""}`,
    );
}

/**
 * 跑自然语言 fallback 检查。仅当 case 未声明 verification 时生效。
 * 检查两类：未知工具名、forbidden_behaviors 中提及的工具被调用。
 */
function runNaturalLanguageFallback(
  run: AgentRun,
  skillCase: SkillCase,
  tag: string,
): string[] {
  const warnings: string[] = [];

  // 1) 未知工具名
  for (const call of run.toolTrace) {
    if (!KNOWN_TOOL_NAMES.has(call.tool)) {
      warnings.push(
        `[case ${run.caseId}${tag}] tool_trace 中出现未知工具：${call.tool}`,
      );
    }
  }

  // 2) 调用了 skill-case 不应默认获取的工具
  const calledTools = new Set(run.toolTrace.map((c) => c.tool));
  const forbiddenByText = new Set<string>();
  for (const text of skillCase.expected.forbidden_behaviors) {
    for (const t of extractToolMentions(text)) {
      forbiddenByText.add(t);
    }
  }
  for (const t of calledTools) {
    if (forbiddenByText.has(t)) {
      warnings.push(
        `[case ${run.caseId}${tag}] 调用了 skill-case forbidden_behaviors 中提及的工具 ${t}，疑似 over-fetch`,
      );
    }
  }

  // 3) outcome=failed/missing 时 final_answer 不应含具体观点性内容
  const hadFailure = run.toolTrace.some(
    (c) => c.outcome === "failed" || c.outcome === "missing",
  );
  if (hadFailure) {
    const suspiciousPatterns = [
      /核心观点是/,
      /作者认为/,
      /视频讲的是/,
      /总结一下/,
    ];
    for (const p of suspiciousPatterns) {
      if (p.test(run.finalAnswer)) {
        warnings.push(
          `[case ${run.caseId}${tag}] outcome 含 failed/missing，但 final_answer 出现了「${p.source}」式表达，疑似虚构结果`,
        );
        break;
      }
    }
  }

  return warnings;
}

/**
 * 对单条 Agent Run 跑硬性确定性检查。
 *
 * 行为：
 * - 如果 skill-case 声明了 verification，优先用结构化规则（自然语言 fallback 中的
 *   "未知工具名"与"失败时虚构"两类仍生效，因为它们与 verification 字段正交）；
 * - 如果 skill-case 未声明 verification，则用自然语言 fallback 全套规则。
 */
function runDeterministicChecks(
  run: AgentRun,
  skillCase: SkillCase | undefined,
  index = 0,
): { warnings: string[]; structuredPassed: boolean } {
  const warnings: string[] = [];
  const tag = index > 0 ? ` (#${index})` : "";
  let structuredPassed = true;

  // 始终跑：未知工具名（与 verification 正交）
  for (const call of run.toolTrace) {
    if (!KNOWN_TOOL_NAMES.has(call.tool)) {
      warnings.push(
        `[case ${run.caseId}${tag}] tool_trace 中出现未知工具：${call.tool}`,
      );
    }
  }

  if (skillCase?.verification) {
    // P1-1：结构化规则优先
    const results = runStructuredChecks(run, skillCase.verification);
    warnings.push(...checksToWarnings(results, run.caseId, tag));
    structuredPassed = results.every((r) => r.passed);
  } else if (skillCase) {
    // Fallback：自然语言抽取 + 失败时虚构检查
    warnings.push(...runNaturalLanguageFallback(run, skillCase, tag));
  }

  // 始终跑：失败时虚构检查（与 verification 正交；只对 failed/missing 触发）
  const hadFailure = run.toolTrace.some(
    (c) => c.outcome === "failed" || c.outcome === "missing",
  );
  if (hadFailure) {
    const suspiciousPatterns = [
      /核心观点是/,
      /作者认为/,
      /视频讲的是/,
      /总结一下/,
    ];
    for (const p of suspiciousPatterns) {
      if (p.test(run.finalAnswer)) {
        warnings.push(
          `[case ${run.caseId}${tag}] outcome 含 failed/missing，但 final_answer 出现了「${p.source}」式表达，疑似虚构结果`,
        );
        break;
      }
    }
  }

  return { warnings, structuredPassed };
}

export async function verifyAgentRuns(
  options: VerifyAgentRunsOptions = {},
): Promise<VerifyAgentRunsResult> {
  const runsDir = resolve(
    options.directory ?? join(process.cwd(), "tests", "agent-runs"),
  );
  const skillCasesPath = resolve(
    options.skillCasesPath ?? join(process.cwd(), "tests", "skill-cases.json"),
  );

  const [skillCases, runs] = await Promise.all([
    loadSkillCases(skillCasesPath),
    loadAgentRuns(runsDir),
  ]);

  const warnings: string[] = [];
  const summaries: AgentRunSummary[] = [];

  // 按 caseId 聚合：同一 case 多次跑取最新一次
  const latestByCase = new Map<string, AgentRun>();
  for (const r of runs) {
    const prev = latestByCase.get(r.caseId);
    if (
      !prev ||
      (r.recordedAt && (!prev.recordedAt || prev.recordedAt < r.recordedAt))
    ) {
      latestByCase.set(r.caseId, r);
    }
  }

  for (const [caseId, run] of latestByCase) {
    const skillCase = skillCases.get(caseId);
    const { warnings: w, structuredPassed } = runDeterministicChecks(
      run,
      skillCase,
    );
    warnings.push(...w);

    // 语义评分检查（CODEX §2.2）：
    // 1) 完整性（缺 / 未知 / 重复）— P0 必修；
    // 2) 阈值（每条 score 是否达到 threshold）— 完整性通过后再判断。
    // 三段 status：pending 与 failed 必须显式区分，避免 PENDING 被算成整体 PASS。
    const semanticWarnings: string[] = [];
    let semanticStatus: "passed" | "failed" | "pending" | "not_applicable" =
      "not_applicable";
    if (skillCase?.semantic_criteria && skillCase.semantic_criteria.length > 0) {
      // 完整性检查
      const completeness = checkSemanticCriteriaCompleteness(run, skillCase);
      semanticWarnings.push(...completeness.warnings);
      if (completeness.missing.length > 0) {
        // Judge 还没跑完 / 跑漏了 — pending 不算 passed，也不算 failed
        semanticStatus = "pending";
      } else if (completeness.unknown.length > 0 || completeness.duplicates.length > 0) {
        // run 评了 case 没声明的 criterion / 重复评分 — 数据脏，FAIL
        semanticStatus = "failed";
      } else {
        // 完整性通过，做阈值检查
        let allAtThreshold = true;
        const criteriaByName = new Map(
          skillCase.semantic_criteria.map((c) => [c.name, c]),
        );
        for (const entry of run.evaluation?.semantic ?? []) {
          const c = criteriaByName.get(entry.criterion);
          if (!c) continue;
          if (entry.score < c.threshold) {
            allAtThreshold = false;
            semanticWarnings.push(
              `[case ${caseId}] semantic.${entry.criterion} 未达阈值 ${c.threshold}（实际 ${entry.score}）`,
            );
          }
        }
        semanticStatus = allAtThreshold ? "passed" : "failed";
      }
    }
    warnings.push(...semanticWarnings);

    // 确定性层 = 已写的 evaluation.deterministic 全通过 AND 新跑的结构化检查全通过
    const existingDeterministicPassed =
      run.evaluation?.deterministic.every((c) => c.passed) ?? true;
    const deterministicStatus: "passed" | "failed" =
      existingDeterministicPassed && structuredPassed ? "passed" : "failed";

    // 综合层：deterministic 失败 → failed；semantic 失败 → failed；
    // semantic pending → pending（不假装通过）；其余 → passed。
    let overallStatus: "passed" | "failed" | "pending";
    if (deterministicStatus === "failed" || semanticStatus === "failed") {
      overallStatus = "failed";
    } else if (semanticStatus === "pending") {
      overallStatus = "pending";
    } else {
      overallStatus = "passed";
    }
    const allPassed = overallStatus === "passed";

    summaries.push({
      caseId,
      runCount: runs.filter((r) => r.caseId === caseId).length,
      latestRecordedAt: run.recordedAt,
      deterministicStatus,
      semanticStatus,
      overallStatus,
      allPassed,
    });
  }

  // 同时按文件读取顺序对所有 run 跑一次确定性检查并把告警也加入；
  // 这样同一 caseId 的多次跑、过期 fixture 都能被发现。
  // 用数组下标做唯一键，避免多个无 recordedAt 的 run 互相覆盖。
  runs.forEach((r, i) => {
    const { warnings: w } = runDeterministicChecks(
      r,
      skillCases.get(r.caseId),
      i,
    );
    warnings.push(...w);
  });

  // 找出 skill-cases.json 中没有任何 Agent Run 记录的 case
  const missingCaseIds: string[] = [];
  for (const id of skillCases.keys()) {
    if (!latestByCase.has(id)) {
      missingCaseIds.push(id);
    }
  }

  // 找出 pending LLM Judge 的 case：已有 Agent Run 且 case 声明了 semantic_criteria
  // 且 run.evaluation.semantic 为空（未跑过 Judge）。
  const pendingSemanticJudge: Array<{ caseId: string; criteriaCount: number }> = [];
  for (const [caseId, run] of latestByCase) {
    const skillCase = skillCases.get(caseId);
    if (!skillCase?.semantic_criteria || skillCase.semantic_criteria.length === 0) {
      continue;
    }
    const hasSemantic = (run.evaluation?.semantic?.length ?? 0) > 0;
    if (!hasSemantic) {
      pendingSemanticJudge.push({
        caseId,
        criteriaCount: skillCase.semantic_criteria.length,
      });
    }
  }

  const passed = summaries.filter((s) => s.overallStatus === "passed").length;
  const pending = summaries.filter((s) => s.overallStatus === "pending").length;
  const failed = summaries.length - passed - pending;

  return {
    total: summaries.length,
    passed,
    failed,
    pending,
    summaries,
    missingCaseIds,
    warnings,
    pendingSemanticJudge,
  };
}
