import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGhosttyAppleScriptArgs,
  discoverDesktopApplications,
  openDesktopApplication,
  resolveBundledApplicationCliPath,
} from "../settings/application-discovery";

const { blockedAccessPaths, spawnMock } = vi.hoisted(() => ({
  blockedAccessPaths: new Set<string>(),
  spawnMock: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises"
  );
  return {
    ...actual,
    access: vi.fn(async (candidatePath, mode) => {
      if (blockedAccessPaths.has(String(candidatePath))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return actual.access(candidatePath, mode);
    }),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe("application discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-application-test-"));
    blockedAccessPaths.clear();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      queueMicrotask(() => {
        child.emit("spawn");
      });
      return child;
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    spawnMock.mockReset();
  });

  it("builds Ghostty AppleScript with an initial working directory", () => {
    expect(buildGhosttyAppleScriptArgs('/repo/.worktrees/feature "quoted"')).toEqual([
      "-e",
      'tell application "Ghostty"',
      "-e",
      "activate",
      "-e",
      "set cfg to new surface configuration",
      "-e",
      'set initial working directory of cfg to "/repo/.worktrees/feature \\"quoted\\""',
      "-e",
      "set win to new window with configuration cfg",
      "-e",
      "activate window win",
      "-e",
      "end tell",
    ]);
  });

  it("opens VS Code source links with --goto line metadata", async () => {
    const binDir = path.join(tempDir, "bin");
    const codePath = path.join(binDir, "code");
    const targetPath = path.join(tempDir, "source.ts");
    const capturePath = path.join(tempDir, "application-open.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(codePath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(codePath, 0o755);
    writeFileSync(targetPath, "line 1\nline 2\n", "utf8");

    await openDesktopApplication(
      {
        applicationId: "vscode",
        kind: "editor",
        targetPath,
        targetLine: 12,
      },
      {
        env: {
          PATH: binDir,
          PWRAGENT_E2E_APPLICATION_OPEN_CAPTURE_PATH: capturePath,
        },
      }
    );

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      invocation: { args: string[]; command: string };
      request: { targetLine?: number; targetPath?: string };
    };
    expect(capture.request).toMatchObject({ targetPath, targetLine: 12 });
    expect(capture.invocation.command).toMatch(/code$/);
    expect(capture.invocation.args).toEqual(["--goto", `${targetPath}:12`]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("discovers IntelliJ IDEA from the idea launcher on PATH", async () => {
    blockHostIntelliJDiscoveryPaths();
    const binDir = path.join(tempDir, "bin");
    const ideaPath = path.join(binDir, "idea");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(ideaPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(ideaPath, 0o755);

    const snapshot = await discoverDesktopApplications({ env: { PATH: binDir } });

    expect(snapshot.editors).toContainEqual(
      expect.objectContaining({
        id: "intellijidea",
        kind: "editor",
        name: "IntelliJ IDEA",
        source: "path",
        executablePath: ideaPath,
        canOpenWorkspace: true,
      })
    );
  });

  it("opens IntelliJ IDEA source links with JetBrains line metadata", async () => {
    blockHostIntelliJDiscoveryPaths();
    const binDir = path.join(tempDir, "bin");
    const ideaPath = path.join(binDir, "idea");
    const targetPath = path.join(tempDir, "source.kt");
    const capturePath = path.join(tempDir, "application-open.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(ideaPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(ideaPath, 0o755);
    writeFileSync(targetPath, "line 1\nline 2\n", "utf8");

    await openDesktopApplication(
      {
        applicationId: "intellijidea",
        kind: "editor",
        targetPath,
        targetLine: 12,
        targetColumn: 4,
      },
      {
        env: {
          PATH: binDir,
          PWRAGENT_E2E_APPLICATION_OPEN_CAPTURE_PATH: capturePath,
        },
      }
    );

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      invocation: { args: string[]; command: string };
      request: { targetColumn?: number; targetLine?: number; targetPath?: string };
    };
    expect(capture.request).toMatchObject({
      targetPath,
      targetLine: 12,
      targetColumn: 4,
    });
    expect(capture.invocation.command).toBe(ideaPath);
    expect(capture.invocation.args).toEqual([
      "--line",
      "12",
      "--column",
      "4",
      targetPath,
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("resolves the bundled VS Code CLI from an app-only install", async () => {
    const appPath = path.join(tempDir, "Visual Studio Code.app");
    const bundledCodePath = path.join(
      appPath,
      "Contents",
      "Resources",
      "app",
      "bin",
      "code"
    );
    mkdirSync(path.dirname(bundledCodePath), { recursive: true });
    writeFileSync(bundledCodePath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(bundledCodePath, 0o755);

    await expect(resolveBundledApplicationCliPath(appPath, ["code"])).resolves.toBe(
      bundledCodePath
    );
  });
});

function blockHostIntelliJDiscoveryPaths(): void {
  for (const appName of ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"]) {
    for (const appPath of [
      path.join("/Applications", appName),
      path.join(os.homedir(), "Applications", appName),
    ]) {
      blockedAccessPaths.add(appPath);
      blockedAccessPaths.add(path.join(appPath, "Contents", "MacOS", "idea"));
    }
  }
}
