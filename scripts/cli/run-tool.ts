/**
 * scripts/cli/run-tool.ts: Skill Runtime 统一 CLI 入口 (router).
 *
 * 子命令:
 *   tool <name> <input>     调单个 Tool
 *   doctor [--json] [--capability ...]   检测环境
 *   setup <media|asr|all> [--plan|--apply] 规划或准备环境
 *   help                            显示 usage
 *
 * 用法:
 *   node dist/cli.mjs help
 *   node dist/cli.mjs doctor
 *   node dist/cli.mjs doctor --json --capability asr
 *   node dist/cli.mjs setup asr --plan
 *   node dist/cli.mjs tool metadata '{"video":"BV1xx411c7mD"}'
 */
import { runToolCommand, TOOL_NAMES } from "./commands/tool.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runSetupCommand } from "./commands/setup.js";

const USAGE = `Skill Runtime CLI 统一入口.

Usage:
  node <skill-root>/dist/cli.mjs <command> [args...]

Commands:
  doctor [--json] [--capability core|media|asr]
      检测环境状态 (不修改机器). 默认人类可读, --json 给 Agent 读.
  setup <media|asr|all> [--plan|--apply]
      输出 plan JSON (默认) 或真跑；ffmpeg 自动安装支持 macOS brew / Linux apt，其它平台返回手动提示.
  tool <tool-name> <input-json>
      调单个 Tool. 工具名: ${TOOL_NAMES.join(", ")}.
  help
      显示本 usage.
`;

interface Command {
  name: string;
  fn: (args: string[]) => Promise<number>;
  /** 子命令是否消费剩余 args */
  consumeAll: boolean;
}

const COMMANDS: Command[] = [
  { name: "doctor", fn: runDoctorCommand, consumeAll: true },
  { name: "setup", fn: runSetupCommand, consumeAll: true },
  { name: "tool", fn: runToolCommand, consumeAll: true },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const cmd = COMMANDS.find((c) => c.name === sub);
  if (!cmd) {
    process.stderr.write(`Error: unknown command "${sub}"\n\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const rest = cmd.consumeAll ? argv.slice(1) : argv;
  const code = await cmd.fn(rest);
  // 不直接调用 process.exit()：字幕等 Tool 可能输出超过 stdout 管道缓冲区的 JSON。
  // 设置退出码后让 Node.js 自然退出，才能等待标准输出完整写入，避免 64 KiB 处截断。
  process.exitCode = code;
}

main().catch((e) => {
  process.stderr.write(
    `Error: runtime CLI crashed: ${(e as Error).message}\n`,
  );
  process.exitCode = 1;
});
