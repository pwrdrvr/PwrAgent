import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

test.each([
  ["ci.yml", "test-macos"],
  ["ci.yml", "desktop-e2e-macos"],
  ["release.yml", "lint"],
  ["release.yml", "test"],
  ["release.yml", "prepare"],
  ["preview-build.yml", "preview"],
  ["check-performance.yml", "compare"],
])("%s %s restores source after a persistent non-cone checkout", (file, job) => {
  const workflow = readFileSync(path.join(root, ".github/workflows", file), "utf8");
  const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [A-Za-z0-9_-]+:\n/)[0];
  const restorations = [...body.matchAll(
    /      - name: Restore complete checkout\n(?:        (?:shell|working-directory): .*\n)*        run: \|\n((?:          .*\n)+)/g,
  )];
  expect(restorations).toHaveLength((body.match(/uses: actions\/checkout@/g) ?? []).length);
  for (const restoration of restorations) {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "checkout-sparse-state-"));
    const directory = path.join(temporary, "repo");
    mkdirSync(directory);
    const globalConfig = path.join(temporary, "gitconfig");
    writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n\teol = crlf\n");
    const git = (...args) => execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig },
    }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgsign", "false");
      git("config", "core.autocrlf", "false");
      git("config", "core.eol", "lf");
      writeFileSync(path.join(directory, "package.json"), "{}");
      const script = path.join(directory, "scripts/ci/macos-e2e-pre-run-cleanup.sh");
      mkdirSync(path.dirname(script), { recursive: true });
      writeFileSync(script, "true\n");
      git("add", ".");
      git("commit", "-qm", "fixture");
      for (let cycle = 0; cycle < 2; cycle += 1) {
        // actions/checkout's non-cone path writes the local flag. Its full
        // checkout disables sparse mode in config.worktree, then unsets
        // extensions.worktreeConfig, exposing the old local flag again.
        git("config", "core.sparseCheckout", "true");
        writeFileSync(path.join(directory, ".git/info/sparse-checkout"), "package.json\n");
        git("read-tree", "-mu", "HEAD");
        expect(existsSync(script)).toBe(false);
        git("sparse-checkout", "disable");
        git("config", "--local", "--unset-all", "extensions.worktreeConfig");
        git("checkout", "--force", "HEAD");
        expect(existsSync(script)).toBe(false);

        // Execute the workflow's Git commands, rather than a second copy of
        // the fix. No repository scripts are available until this succeeds.
        for (const command of restoration[1].trim().split("\n")) {
          const [executable, ...args] = command.trim().split(/\s+/);
          expect(executable).toBe("git");
          git(...args);
        }
        expect(readFileSync(script, "utf8")).toBe("true\n");
        expect(git("config", "--local", "core.sparseCheckout")).toBe("false");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});
