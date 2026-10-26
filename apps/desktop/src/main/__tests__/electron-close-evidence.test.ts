import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { closeElectronApplication, killProcessTree } from "../../../e2e/fixtures/electron-app";
import { captureElectronCloseEvidence, observeElectronLauncher } from "../../../e2e/fixtures/electron-close-evidence";
import { assertElectronCloseCompleted } from "../../../e2e/fixtures/electron-shutdown-policy";

const SECRET = "do-not-collect-credential-7f64";
function launchHolder(detachedHolder = false) {
  return spawn(process.execPath, ["-e", [
    'const { spawn } = require("node:child_process");',
    `const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(SECRET)}], { detached: ${detachedHolder}, stdio: ["ignore", 1, 2] });`,
    'process.stdout.write(String(holder.pid) + "\\n");',
    'process.stdin.once("data", () => process.exit(0));',
  ].join(" "), SECRET], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, EVIDENCE_TEST_SECRET: SECRET },
  });
}
function evidence(file: string) {
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(SECRET);
  expect(Buffer.byteLength(text)).toBeLessThan(128 * 1024);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe.skipIf(process.platform !== "linux")("owning-test Linux close evidence", () => {
  it.each([false, true])("finds actual inherited descriptors after launcher exit (escaped group: %s)", async (escaped) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-close-evidence-"));
    const file = path.join(root, "evidence.jsonl");
    const launcher = launchHolder(escaped);
    const closed = once(launcher, "close");
    const exited = once(launcher, "exit");
    let holderPid: number | undefined;
    try {
      observeElectronLauncher(launcher);
      const [line] = await once(launcher.stdout!, "data");
      holderPid = Number(String(line).trim());
      launcher.stdin!.end("quit");
      await exited;
      captureElectronCloseEvidence({ child: launcher, diagnosticsFile: file, launchId: "fixture-launch", reason: "timeout" });
      const [snapshot] = evidence(file);
      expect(snapshot).toMatchObject({
        kind: "owning-test-close-deadline", launchId: "fixture-launch", reason: "timeout",
        launcher: { exitObserved: true, closeObserved: false, exitCode: 0, stdio: expect.arrayContaining([{ fd: 1, present: true, destroyed: false, closed: false, readableEnded: false, writableFinished: false }]) },
        linux: { status: "complete", endpointStatus: "sampled" },
      });
      expect(snapshot.linux.holders).toEqual(expect.arrayContaining([
        expect.objectContaining({ pid: holderPid, executableClass: "node", fd: 1, stdio: [1], sides: ["launcher"], accessMode: 2 }),
        expect.objectContaining({ pid: holderPid, fd: 2, stdio: [2], sides: ["launcher"], accessMode: 2 }),
      ]));
      expect(snapshot.linux.members.some((row: { pid: number }) => row.pid === holderPid)).toBe(!escaped);
    } finally {
      await killProcessTree(launcher);
      if (holderPid) { try { process.kill(holderPid, "SIGKILL"); } catch { /* Already reaped. */ } }
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing launcher endpoints when observation starts after exit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-close-late-"));
    const file = path.join(root, "evidence.jsonl");
    const launcher = launchHolder();
    const closed = once(launcher, "close");
    const exited = once(launcher, "exit");
    try {
      await once(launcher.stdout!, "data");
      launcher.stdin!.end("quit");
      await exited;
      captureElectronCloseEvidence({ child: launcher, diagnosticsFile: file, reason: "timeout" });
      const [snapshot] = evidence(file);
      expect(snapshot.launcher.initialIdentity).toBeUndefined();
      expect(snapshot.launcher.endpoints.every(({ side }: { side: string }) => side === "worker")).toBe(true);
      expect(snapshot.linux.endpointStatus).toBe("launcher-endpoints-unavailable");
    } finally {
      await killProcessTree(launcher);
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not capture a healthy owning-test close", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-close-healthy-"));
    const file = path.join(root, "evidence.jsonl");
    const launcher = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "pipe" });
    const closed = once(launcher, "close");
    try {
      observeElectronLauncher(launcher);
      const app = {
        process: () => launcher,
        evaluate: async () => undefined,
        close: async () => { await closed; },
      } as unknown as ElectronApplication;
      const summary = await closeElectronApplication(app, { diagnosticsFile: file });
      expect(summary.classification).toBe("healthy");
      expect(evidence(file).map(({ kind }) => kind)).toEqual(["close-summary"]);
    } finally {
      await killProcessTree(launcher);
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures before forced cleanup and still fails the abnormal owning test", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-close-deadline-"));
    const file = path.join(root, "evidence.jsonl");
    const launcher = launchHolder();
    const closed = once(launcher, "close");
    const exited = once(launcher, "exit");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      observeElectronLauncher(launcher);
      const [line] = await once(launcher.stdout!, "data");
      const holderPid = Number(String(line).trim());
      launcher.stdin!.end("quit");
      await exited;
      const app = {
        process: () => launcher,
        evaluate: async () => { throw new Error("Already exited"); },
        close: async () => { await closed; },
      } as unknown as ElectronApplication;
      const summary = await closeElectronApplication(app, { diagnosticsFile: file, launchId: "owning-test" });
      const records = evidence(file);
      expect(records.map(({ kind }) => kind)).toEqual(["owning-test-close-deadline", "close-summary"]);
      expect(records[0].linux.holders.some((row: { pid: number }) => row.pid === holderPid)).toBe(true);
      expect(records[0].launcher).toMatchObject({ exitObserved: true, closeObserved: false });
      expect(launcher.stdout!.destroyed).toBe(true);
      expect(summary).toMatchObject({ gracefulCloseOutcome: "timeout", forceExitOutcome: "exited", classification: "force-killed" });
      expect(() => assertElectronCloseCompleted(summary)).toThrow("Electron close timed out in the owning test");
    } finally {
      log.mockRestore();
      await killProcessTree(launcher);
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
