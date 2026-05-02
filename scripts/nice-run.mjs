#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setPriority } from "node:os";

const NICE_LEVEL = 19;
const POSIX_PLATFORMS = new Set(["darwin", "linux"]);

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/nice-run.mjs <command> [args...]",
      "",
      "Runs the command at niceness 19 on macOS/Linux and as-is on other platforms.",
      "",
    ].join("\n"),
  );
}

function applyNiceness(platform) {
  if (!POSIX_PLATFORMS.has(platform)) {
    return;
  }

  try {
    setPriority(NICE_LEVEL);
  } catch (error) {
    process.stderr.write(
      `Unable to set process niceness to ${NICE_LEVEL}; running without priority adjustment. ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function run(argv = process.argv.slice(2), platform = process.platform) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return argv.length === 0 ? 2 : 0;
  }

  applyNiceness(platform);

  const [command, ...args] = argv;

  const child = spawn(command, args, {
    shell: platform === "win32",
    stdio: "inherit",
    windowsHide: false,
  });

  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  return undefined;
}

const result = run();
if (typeof result === "number") {
  process.exit(result);
}
