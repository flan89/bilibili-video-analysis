import { describe, expect, it } from "vitest";

import {
  buildMediaSteps,
  determineSetupOverall,
  isMediaReady,
  type SetupPlan,
} from "../../scripts/cli/commands/setup.js";

function snapshot(capabilities: SetupPlan["doctorSnapshot"]["capabilities"]): SetupPlan["doctorSnapshot"] {
  return { capabilities };
}

describe("setup Runtime 闭环", () => {
  it("无受支持包管理器时 plan 明确要求手动准备", () => {
    const steps = buildMediaSteps({ kind: "unknown", hint: "当前平台不支持自动安装" });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.step).toContain("手动");
    expect(steps[0]?.description).toContain("不支持自动安装");
  });

  it("media 必须同时具备 ffmpeg 与 ffprobe", () => {
    expect(isMediaReady(snapshot([
      { capability: "media", status: "unavailable", checks: { ffmpeg: "ok", ffprobe: "missing" } },
    ]))).toBe(false);
    expect(isMediaReady(snapshot([
      { capability: "media", status: "ok", checks: { ffmpeg: "ok", ffprobe: "ok" } },
    ]))).toBe(true);
  });

  it("步骤未报错但 doctorAfter 仍不可用时不能返回 ok", () => {
    const overall = determineSetupOverall(
      "media",
      [{ step: "安装", status: "ok", detail: "exit 0", durationSeconds: 1 }],
      snapshot([{ capability: "media", status: "unavailable", checks: { ffmpeg: "ok", ffprobe: "missing" } }]),
    );
    expect(overall).toBe("partial");
  });

  it("所有目标能力经 doctorAfter 核验后才返回 ok", () => {
    const overall = determineSetupOverall(
      "asr",
      [{ step: "准备", status: "ok", detail: "done", durationSeconds: 1 }],
      snapshot([
        { capability: "media", status: "ok", checks: { ffmpeg: "ok", ffprobe: "ok" } },
        { capability: "asr", status: "ok", checks: { runtimeState: "ok" } },
      ]),
    );
    expect(overall).toBe("ok");
  });
});
