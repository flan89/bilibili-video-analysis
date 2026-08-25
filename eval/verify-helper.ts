/**
 * verify.ts 拆出来的可复用 helper。
 * 让 scripts/cli/verify-agent-runs.ts 与 scripts/cli/run-semantic-judge.ts
 * 都能直接 loadSkillCases 而不必重复 Zod schema。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { VerificationSchema } from "./verification.js";
import { SemanticCriterionSchema } from "./semantic-judge.js";

export const SkillCaseSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    // M7 新增 real_topic：无给定视频的主题型请求（先搜索发现候选再研究）。
    execution: z.enum(["real_video", "fixture_result", "real_topic"]),
    tool_outcome: z.enum([
      "success",
      "selection_required",
      "missing",
      "success_partial",
      "failed",
    ]),
    user_request: z.string().min(1).optional(),
    expected: z.object({
      required_actions: z.array(z.string().min(1)),
      forbidden_behaviors: z.array(z.string().min(1)),
    }),
    verification: VerificationSchema.optional(),
    semantic_criteria: z.array(SemanticCriterionSchema).optional(),
  })
  .passthrough();
export type SkillCase = z.infer<typeof SkillCaseSchema>;

export async function loadSkillCases(
  path: string,
): Promise<Map<string, SkillCase>> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} 不是数组`);
  }
  const map = new Map<string, SkillCase>();
  for (const item of parsed) {
    const c = SkillCaseSchema.parse(item);
    map.set(c.id, c);
  }
  return map;
}
