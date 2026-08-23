import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * tests/unit/run-tool.test.ts: 统一 Runtime CLI 单元测试.
 *
 * 测什么:
 *  1. 未知 tool 名 -> 退出码 2 + USAGE 输出
 *  2. 缺 input JSON -> 退出码 2 + 错误信息
 *  3. 非法 JSON -> 退出码 2 + 错误信息
 *  4. USAGE 列出 10 个 tool (M7 新增 search-videos, M8 新增 popular-videos / hot-searches / related-videos)
 *
 * 跑真实 Tool 涉及 B 站 API, 这里不调 Tool, 只测 CLI 路由.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../dist/cli.mjs", import.meta.url));

beforeAll(() => {
  const built = spawnSync(process.execPath, ["scripts/build-runtime.mjs"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  expect(built.status, built.stderr).toBe(0);
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, no_proxy: "*", https_proxy: "" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("统一 Runtime CLI (tool 子命令)", () => {
  it("未知 tool 名 -> 退出码 2 + USAGE 输出", () => {
    const { status, stderr } = runCli(["tool", "unknown-tool", "{}"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown tool");
    expect(stderr).toContain("Available tools");
  });

  it("缺 input JSON -> 退出码 2 + 错误信息", () => {
    const { status, stderr } = runCli(["tool", "metadata"]);
    expect(status).toBe(2);
    expect(stderr).toContain("missing <input-json>");
  });

  it("非法 JSON -> 退出码 2 + 错误信息", () => {
    const { status, stderr } = runCli(["tool", "metadata", "{not-json}"]);
    expect(status).toBe(2);
    expect(stderr).toContain("invalid JSON input");
  });

  it("USAGE 列出 10 个 tool", () => {
    const { stderr } = runCli(["tool", "metadata"]);
    expect(stderr).toContain("metadata");
    expect(stderr).toContain("subtitle");
    expect(stderr).toContain("danmaku");
    expect(stderr).toContain("comments");
    expect(stderr).toContain("comment-replies");
    expect(stderr).toContain("frames");
    expect(stderr).toContain("search-videos");
    expect(stderr).toContain("popular-videos");
    expect(stderr).toContain("hot-searches");
    expect(stderr).toContain("related-videos");
    expect(stderr).toContain("getBilibiliMetadata");
    expect(stderr).toContain("getBilibiliSubtitle");
    expect(stderr).toContain("getBilibiliDanmaku");
    expect(stderr).toContain("getBilibiliComments");
    expect(stderr).toContain("getBilibiliCommentReplies");
    expect(stderr).toContain("getBilibiliFrames");
    expect(stderr).toContain("searchBilibiliVideos");
    expect(stderr).toContain("getBilibiliPopularVideos");
    expect(stderr).toContain("getBilibiliHotSearches");
    expect(stderr).toContain("getBilibiliRelatedVideos");
  });

  it("未知顶层命令 -> 退出码 2 + USAGE 列出 commands", () => {
    const { status, stderr } = runCli(["foo"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("Commands:");
  });

  it("help 显示 4 个子命令", () => {
    const { status, stdout } = runCli(["help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("setup");
    expect(stdout).toContain("tool");
  });
});
