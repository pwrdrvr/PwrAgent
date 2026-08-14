import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureFirstElectronShutdownFailure,
  type ElectronProcessTreeSnapshot,
} from "../../../e2e/fixtures/electron-shutdown-artifacts";
import type { ElectronShutdownSummary } from "../../../e2e/fixtures/electron-shutdown-policy";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      await rm(root, { force: true, recursive: true })
    ),
  );
});

describe("captureFirstElectronShutdownFailure", () => {
  it("copies the first abnormal fixture main log and ignores later failures", async () => {
    const root = await makeTemporaryRoot();
    const artifactDir = path.join(root, "artifacts");
    const firstHome = path.join(root, "first-home");
    const secondHome = path.join(root, "second-home");
    await writeMainLog(firstHome, "first failure log");
    await writeMainLog(secondHome, "second failure log");

    await expect(captureFirstElectronShutdownFailure({
      artifactDir,
      homeRoot: firstHome,
      processTree: processTreeSnapshot(),
      summary: shutdownSummary("first", "force-killed"),
    })).resolves.toBe(true);
    await expect(captureFirstElectronShutdownFailure({
      artifactDir,
      homeRoot: secondHome,
      processTree: processTreeSnapshot(),
      summary: shutdownSummary("second", "force-killed"),
    })).resolves.toBe(false);

    const files = await readdir(artifactDir);
    expect(files).toContain("1-profile-default.main.log");
    expect(await readFile(
      path.join(artifactDir, "1-profile-default.main.log"),
      "utf8",
    )).toBe("first failure log");
    const failure = JSON.parse(await readFile(
      path.join(artifactDir, "shutdown-failure.json"),
      "utf8",
    )) as { summary: { launchId: string } };
    expect(failure.summary.launchId).toBe("first");
  });

  it("does not claim the artifact directory for a healthy close", async () => {
    const root = await makeTemporaryRoot();
    const artifactDir = path.join(root, "artifacts");

    await expect(captureFirstElectronShutdownFailure({
      artifactDir,
      homeRoot: path.join(root, "home"),
      summary: shutdownSummary("healthy", "healthy"),
    })).resolves.toBe(false);
    await expect(readdir(artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-shutdown-artifact-"));
  temporaryRoots.push(root);
  return root;
}

async function writeMainLog(homeRoot: string, contents: string): Promise<void> {
  const logDir = path.join(homeRoot, "Library", "Logs", "PwrAgent");
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, "profile-default.main.log"), contents);
}

function processTreeSnapshot(): ElectronProcessTreeSnapshot {
  return {
    capturedAt: "2026-08-14T00:00:00.000Z",
    descendantPids: [42, 43],
    exitCode: null,
    killed: false,
    platform: "darwin",
    rootPid: 41,
    signalCode: null,
  };
}

function shutdownSummary(
  launchId: string,
  classification: ElectronShutdownSummary["classification"],
): ElectronShutdownSummary {
  const notObserved = { durationMs: null, outcome: "not-observed" as const };
  return {
    schemaVersion: 1,
    kind: "close-summary",
    launchId,
    classification,
    elapsedMs: classification === "healthy" ? 100 : 7_000,
    quitRequestOutcome: "completed",
    gracefulCloseOutcome: classification === "healthy" ? "closed" : "timeout",
    forceExitOutcome: classification === "force-killed" ? "exited" : "not-needed",
    phases: {
      rendererWindow: notObserved,
      messaging: notObserved,
      appServer: notObserved,
      overall: notObserved,
    },
    circuit: {
      enabled: true,
      consecutiveAbnormalCloses: classification === "healthy" ? 0 : 1,
      limit: 2,
      tripped: false,
    },
  };
}
