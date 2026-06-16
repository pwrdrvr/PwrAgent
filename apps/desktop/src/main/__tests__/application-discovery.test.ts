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
  extractIcnsPng,
  isIcnsBuffer,
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

// Many cases mock Unix executable layouts (#!/bin/sh launchers, chmod 0o755, macOS .app bundles, /Applications); those are gated off Windows. Windows application discovery coverage is tracked separately.
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

  it.skipIf(process.platform === "win32")("opens VS Code source links with --goto line metadata", async () => {
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

  it.skipIf(process.platform === "win32")("discovers IntelliJ IDEA from the idea launcher on PATH", async () => {
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

  it.skipIf(process.platform === "win32")("opens IntelliJ IDEA source links with JetBrains line metadata", async () => {
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

  it.skipIf(process.platform === "win32")("resolves the bundled VS Code CLI from an app-only install", async () => {
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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG: signature + an IHDR chunk carrying the width at byte 16. */
function fakePng(width: number): Buffer {
  const png = Buffer.alloc(33);
  PNG_MAGIC.copy(png, 0);
  png.writeUInt32BE(13, 8); // IHDR data length
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(width, 16); // width
  png.writeUInt32BE(width, 20); // height
  return png;
}

/** Wrap entry bodies in the flat `.icns` container format. */
function fakeIcns(entries: Array<{ type: string; body: Buffer }>): Buffer {
  const blocks = entries.map(({ type, body }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([header, body]);
  });
  const payload = Buffer.concat(blocks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}

describe("icns icon extraction", () => {
  it("detects the icns container magic", () => {
    expect(isIcnsBuffer(fakeIcns([{ type: "ic07", body: fakePng(128) }]))).toBe(true);
    expect(isIcnsBuffer(Buffer.from("not an icon file at all"))).toBe(false);
    expect(isIcnsBuffer(Buffer.alloc(2))).toBe(false);
  });

  it("picks the smallest PNG at least 2x the render size", () => {
    const icns = fakeIcns([
      { type: "ic13", body: fakePng(256) },
      { type: "ic07", body: fakePng(128) },
      { type: "ic12", body: fakePng(64) },
    ]);
    const png = extractIcnsPng(icns);
    expect(png).toBeDefined();
    expect(png!.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // Render size is 48px, so the 128px entry is the smallest >= 96.
    expect(png!.readUInt32BE(16)).toBe(128);
  });

  it("falls back to the largest PNG when none meet the target size", () => {
    const icns = fakeIcns([
      { type: "ic11", body: fakePng(32) },
      { type: "ic12", body: fakePng(64) },
    ]);
    expect(extractIcnsPng(icns)!.readUInt32BE(16)).toBe(64);
  });

  it("returns undefined for an icns with no PNG entries", () => {
    const icns = fakeIcns([{ type: "ic04", body: Buffer.alloc(40, 1) }]);
    expect(extractIcnsPng(icns)).toBeUndefined();
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
