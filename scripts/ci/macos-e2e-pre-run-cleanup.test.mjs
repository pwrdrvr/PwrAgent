import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The script kills processes on a shared, persistent CI guest, so the part
// worth locking down is which rows it selects. `REAP_PS_SNAPSHOT_FILE` feeds
// it a synthetic `ps` table and forces report-only mode, so these tests
// exercise the real classifier without a single signal being sent.
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "macos-e2e-pre-run-cleanup.sh",
);

const SCOPE = "/Users/admin/actions-runner/_work/PwrAgent";
const BUNDLE = `${SCOPE}/PwrAgent/node_modules/.pnpm/electron@41.10.3/node_modules/electron/dist/Electron.app`;

/** One `ps -Ao pid=,ppid=,state=,etime=,command=` row. */
const row = (pid, ppid, state, command, etime = "01:23") =>
  `${pid} ${ppid} ${state} ${etime} ${command}`;

// argv[1] is the app entry point, which lives in the same checkout as the
// bundle — deriving it keeps foreign-bundle rows realistic instead of
// accidentally sprinkling our own workspace path into someone else's argv.
const electronMain = (pid, ppid = 1, state = "S", bundle = BUNDLE) =>
  row(
    pid,
    ppid,
    state,
    `${bundle}/Contents/MacOS/Electron ${bundle.replace(/\/node_modules\/.*$/, "")}/apps/desktop/out/main/index.js`,
  );

const electronHelper = (pid, ppid, state = "S", bundle = BUNDLE) =>
  row(
    pid,
    ppid,
    state,
    `${bundle}/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=renderer`,
  );

let workDir;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "reap-orphan-electron-test-"));
});

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

let tableCounter = 0;

function run(rows, { scope = SCOPE, selfPid = "9000", env = {}, stderr = "inherit" } = {}) {
  const tableFile = path.join(workDir, `table-${tableCounter++}.txt`);
  writeFileSync(tableFile, `${rows.join("\n")}\n`, "utf8");
  return execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", stderr],
    env: {
      ...process.env,
      RUNNER_WORKSPACE: scope,
      REAP_PS_SNAPSHOT_FILE: tableFile,
      REAP_SELF_PID: selfPid,
      GITHUB_STEP_SUMMARY: "",
      ...env,
    },
  });
}

const inScopeCount = (output) =>
  Number(/in scope\s+(\d+) orphaned/.exec(output)?.[1]);
const outOfScopeCount = (output) =>
  Number(/out of scope\s+(\d+) Electron/.exec(output)?.[1]);

// Every row a real runner would show while sitting idle between jobs.
const BASELINE = [
  row(1, 0, "Ss", "/sbin/launchd", "21-22:28:55"),
  row(9000, 8000, "S", "bash /Users/admin/actions-runner/_work/_temp/step.sh"),
  row(8000, 500, "S", "/Users/admin/actions-runner/bin/Runner.Worker"),
];

describe.skipIf(process.platform === "win32")("macos-e2e-pre-run-cleanup.sh", () => {
  it("reports a clean runner when no Electron is running", () => {
    const output = run(BASELINE);
    expect(inScopeCount(output)).toBe(0);
    expect(outOfScopeCount(output)).toBe(0);
    expect(output).toContain("report-only");
  });

  it("selects an orphaned Electron main and its helper", () => {
    const output = run([...BASELINE, electronMain(4100), electronHelper(4101, 4100)]);
    expect(inScopeCount(output)).toBe(2);
    expect(output).toContain("4100");
    expect(output).toContain("4101");
  });

  it("counts but never selects Electron outside the runner workspace", () => {
    // PwrSnap on the shared guest, and an operator's own checkout. Killing
    // either would be exactly the collateral this scope exists to prevent.
    const pwrSnap = "/Users/admin/actions-runner/_work/PwrSnap/PwrSnap/node_modules/electron/dist/Electron.app";
    const operator = "/Users/admin/dev/scratch/node_modules/electron/dist/Electron.app";
    const output = run([
      ...BASELINE,
      electronMain(5100, 1, "S", pwrSnap),
      electronHelper(5101, 5100, "S", pwrSnap),
      electronMain(5200, 1, "S", operator),
    ]);
    expect(inScopeCount(output)).toBe(0);
    expect(outOfScopeCount(output)).toBe(3);
    expect(output).not.toContain("5100");
  });

  it("does not select a workspace whose path merely shares the scope prefix", () => {
    const sibling = "/Users/admin/actions-runner/_work/PwrAgent2/PwrAgent2/node_modules/electron/dist/Electron.app";
    const output = run([...BASELINE, electronMain(6100, 1, "S", sibling)]);
    expect(inScopeCount(output)).toBe(0);
    expect(outOfScopeCount(output)).toBe(1);
  });

  it("does not select a foreign Electron that merely mentions our workspace", () => {
    // A PwrSnap job comparing against this checkout, or an operator's shell
    // history landing in argv. The scope has to be a prefix of argv[0].
    const foreign = "/Users/admin/actions-runner/_work/PwrSnap/PwrSnap/node_modules/electron/dist/Electron.app";
    const output = run([
      ...BASELINE,
      row(6200, 1, "S", `${foreign}/Contents/MacOS/Electron --compare-to=${SCOPE}/PwrAgent/out`),
    ]);
    expect(inScopeCount(output)).toBe(0);
    expect(outOfScopeCount(output)).toBe(1);
  });

  it("selects a bundle launched through a wrapper, where argv[0] is the interpreter", () => {
    const output = run([
      ...BASELINE,
      row(6300, 1, "S", `/bin/sh ${BUNDLE}/Contents/MacOS/Electron --type=renderer`),
    ]);
    expect(inScopeCount(output)).toBe(1);
    expect(output).toContain("6300");
  });

  it("never selects its own process tree", () => {
    // An Electron launched by this job would descend from the step shell.
    // Nothing beneath the running script may ever be signalled.
    const output = run([
      ...BASELINE,
      electronMain(7100, 9000),
      electronHelper(7101, 7100),
    ]);
    expect(inScopeCount(output)).toBe(0);
  });

  it("ignores zombies, which are already dead and hold nothing", () => {
    const output = run([...BASELINE, electronMain(7200, 1, "Z"), electronMain(7201, 1, "S")]);
    expect(inScopeCount(output)).toBe(1);
    expect(output).toContain("7201");
    expect(output).not.toContain("7200");
  });

  it("reports elapsed time so a leftover can be dated to a previous job", () => {
    const output = run([
      ...BASELINE,
      row(
        7300,
        1,
        "S",
        `${BUNDLE}/Contents/MacOS/Electron ${SCOPE}/PwrAgent/apps/desktop/out/main/index.js`,
        "2:14:07",
      ),
    ]);
    expect(output).toContain("elapsed=2:14:07");
  });

  it("refuses to run when no workspace is set rather than guessing a scope", () => {
    let failure;
    try {
      run(BASELINE, { scope: "", env: { GITHUB_WORKSPACE: "" }, stderr: "pipe" });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toContain("refusing to guess a kill scope");
  });
});
