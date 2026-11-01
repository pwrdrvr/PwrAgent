import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const step = workflow.split("      - name: Compare authoritative Homebrew and Winget channels\n")[1].split("\n      - name:")[0];
const command = step.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");

describe.skipIf(process.platform === "win32")("release channel preflight diagnostics", () => {
  it.each([
    [0, { status: "complete", stable: { version: "1.3.2" } }],
    [1, { status: "blocked", findings: [{ message: "Published package checksum differs" }] }],
    [23, { status: "incomplete", error: "GitHub CLI: gh executable not found on PATH" }],
    [1, { status: "incomplete", error: "GitHub API: HTTP 401" }],
    [0, { status: "blocked", findings: [{ message: "Contradictory audit exit" }] }],
    [23, { status: "incomplete", error: "GitHub API: HTTP 403" }, true],
    [0, { status: "complete" }, true],
  ])("logs audit exit %s and preserves failure even if summary writing fails", (exitCode, audit, summaryFails = false) => {
    const temp = mkdtempSync(join(tmpdir(), "release-channel-audit-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(audit)}'\nexit ${exitCode}\n`, { mode: 0o755 });
      const summary = summaryFails ? temp : join(temp, "summary.md");
      const result = spawnSync("bash", ["-e", "-c", command], { cwd: root, encoding: "utf8",
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary } });
      expect(result.status, result.stderr).toBe(exitCode || (summaryFails || audit.status !== "complete" ? 1 : 0));
      expect(JSON.parse(result.stdout)).toEqual({ auditExitCode: exitCode, audit });
      if (!summaryFails) expect(readFileSync(summary, "utf8")).toContain(result.stdout.trim());
      expect(JSON.parse(readFileSync(join(temp, "package-manager-preflight.json"), "utf8"))).toEqual(audit);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

it("reports a real missing gh executable as incomplete JSON without attempting authenticated reads", () => {
  const temp = mkdtempSync(join(tmpdir(), "release-channel-no-gh-"));
  try {
    const result = spawnSync(process.execPath, [join(root, "scripts/package-manager-release.mjs"), "--audit"], {
      encoding: "utf8", env: { PATH: temp },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "incomplete",
      error: "GitHub CLI at repos/pwrdrvr/PwrAgent/releases/latest: gh executable not found on PATH; read incomplete, do not infer absence" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it.each([
  ["missing", ""],
  ["malformed", "not-json"],
  ["oversized", JSON.stringify({ status: "incomplete", error: "x".repeat(64 * 1024) })],
])(
  "bounds %s audit diagnostics", (_name, input) => {
    const temp = mkdtempSync(join(tmpdir(), "release-channel-report-"));
    try {
      const file = join(temp, "audit.json");
      if (input) writeFileSync(file, input);
      const result = spawnSync(process.execPath, [join(root, "scripts/release/report-channel-audit.mjs"), file, "23"], {
        encoding: "utf8", env: {},
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.length).toBeLessThan(1024);
      expect(JSON.parse(result.stdout)).toMatchObject({ auditExitCode: 23, status: "incomplete" });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
