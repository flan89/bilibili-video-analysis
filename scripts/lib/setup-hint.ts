import path from "node:path";
import { skillRoot } from "./paths.js";
import type { SetupHint } from "../models/acquisition.js";

/** 生成可直接执行的环境检查与准备命令，不使用容易失效的占位路径。 */
export function makeSetupHint(
  capability: "media" | "asr",
  reason: string,
): SetupHint {
  const cli = path.join(skillRoot(), "dist", "cli.mjs");
  const command = (args: string[]) => ({ executable: process.execPath, args: [cli, ...args] });
  return {
    capability,
    reason,
    doctorCommand: command(["doctor", "--json", "--capability", capability]),
    planCommand: command(["setup", capability, "--plan"]),
    applyCommand: command(["setup", capability, "--apply"]),
  };
}
