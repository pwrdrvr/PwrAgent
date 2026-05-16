import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGhosttyAppleScriptArgs,
  openDesktopApplication,
  resolveBundledApplicationCliPath,
} from "../settings/application-discovery";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

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
    const targetPath = path.join(tempDir, "source.ts");
    const capturePath = path.join(tempDir, "application-open.json");
    const fakeBinDir = path.join(tempDir, "bin");
    const fakeCodePath = path.join(fakeBinDir, "code");
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(targetPath, "line 1\nline 2\n", "utf8");
    writeFileSync(fakeCodePath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(fakeCodePath, 0o755);

    await openDesktopApplication(
      {
        applicationId: "vscode",
        kind: "editor",
        targetPath,
        targetLine: 12,
      },
      {
        env: {
          PATH: fakeBinDir,
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
