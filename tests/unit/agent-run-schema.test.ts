/**
 * Agent Run 数据模型校验。
 *
 * 覆盖：
 * - 正常 Agent Run 通过校验；
 * - 缺必填字段时拒绝；
 * - 额外字段被 strict 拒绝；
 * - outcome 不在枚举内时拒绝。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRunSchema } from "../../eval/schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/agent-runs/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("AgentRunSchema", () => {
  it("接受 fixture/content-summary.json（最小必填）", () => {
    const data = loadFixture("content-summary.json");
    const parsed = AgentRunSchema.parse(data);
    expect(parsed.caseId).toBe("content-summary");
    expect(parsed.toolTrace).toHaveLength(2);
  });

  it("缺 finalAnswer 时拒绝", () => {
    const data = loadFixture("content-summary.json") as Record<string, unknown>;
    delete data["finalAnswer"];
    expect(() => AgentRunSchema.parse(data)).toThrow();
  });

  it("额外字段被 strict 拒绝", () => {
    const data = loadFixture("content-summary.json") as Record<string, unknown>;
    data["unknownField"] = "x";
    expect(() => AgentRunSchema.parse(data)).toThrow();
  });

  it("outcome 不在枚举内时拒绝", () => {
    const data = JSON.parse(JSON.stringify(loadFixture("content-summary.json")));
    data.toolTrace[0].outcome = "weird";
    expect(() => AgentRunSchema.parse(data)).toThrow();
  });

  it("recordedAt 缺省时仍合法", () => {
    const data = loadFixture("content-summary.json") as Record<string, unknown>;
    delete data["recordedAt"];
    const parsed = AgentRunSchema.parse(data);
    expect(parsed.recordedAt).toBeUndefined();
  });
});
