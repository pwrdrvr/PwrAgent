import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it.skipIf(process.platform !== "darwin")("worktree cleanup obeys Git, APFS and live-process oracles", () => {
  execFileSync("python3", [".agents/skills/pwragent-worktree-cache-cleanup/tests/test_cleanup.py"], {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe",
    timeout: 60_000,
  });
}, 65_000);
