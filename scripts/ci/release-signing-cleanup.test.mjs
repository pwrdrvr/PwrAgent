import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)), "utf8");
const signingJob = workflow.split("\n  sign:\n")[1].split("\n  linux-package:\n")[0];
const step = (name) => signingJob.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0];
const commands = (body) => body.match(/        run: \|\n((?:          .*\n)+)/)[1]
  .split("\n").map((line) => line.slice(10)).join("\n");

// The macOS job's POSIX TMPDIR contract also runs on Linux without invoking
// any Apple tooling or loading real credentials.
describe.skipIf(process.platform === "win32")("macOS signing credential cleanup", () => {
  it.each([0, 23])("removes decoded credentials after signing exits %s", (exitCode) => {
    const root = mkdtempSync(path.join(tmpdir(), "release-signing-cleanup-"));
    try {
      const runnerTemp = path.join(root, "runner-temp");
      mkdirSync(runnerTemp);
      const unrelated = path.join(runnerTemp, "other-job.txt");
      writeFileSync(unrelated, "preserve me");
      const githubEnv = path.join(root, "github-env");
      const env = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv };
      delete env.PWRAGENT_SIGNING_TEMP_DIR;
      const run = (body, cwd = root) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", commands(body)], {
        cwd, env, encoding: "utf8",
      });
      const initialized = run(step("Initialize isolated signing workspace"));
      expect(initialized.status, initialized.stderr).toBe(0);
      const [name, directory] = readFileSync(githubEnv, "utf8").trim().split("=");
      env[name] = directory;
      expect(path.dirname(directory)).toBe(runnerTemp);
      expect(statSync(directory).mode & 0o077).toBe(0);
      const signing = step("Sign, notarize, package macOS");
      const tempVariable = signing.match(/TMPDIR: \$\{\{ env\.(\w+) \}\}/)[1];
      env.TMPDIR = env[tempVariable];
      const workspace = path.join(root, "release-signing");
      const scripts = path.join(workspace, "apps/desktop/scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(path.join(scripts, "release.mjs"), `
        import { writeFileSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        for (const file of ["AuthKey_FIXTURE.p8", "fixture.p12", "fixture.keychain-db"]) {
          writeFileSync(join(tmpdir(), file), "contrived credential");
        }
        process.exit(${exitCode});
      `);
      const signed = run(signing, workspace);
      expect(signed.status, signed.stderr).toBe(exitCode);
      expect(existsSync(path.join(directory, "AuthKey_FIXTURE.p8"))).toBe(true);
      const cleanup = step("Remove temporary signing credentials");
      expect(cleanup).toContain("if: always()");
      const cleaned = run(cleanup);
      expect(cleaned.status, cleaned.stderr).toBe(0);
      expect(existsSync(directory)).toBe(false);
      expect(readFileSync(unrelated, "utf8")).toBe("preserve me");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
