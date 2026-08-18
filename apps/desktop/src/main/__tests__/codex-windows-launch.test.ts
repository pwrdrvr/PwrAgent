import { describe, expect, it } from "vitest";
import {
  isWindowsSpawnableCommand,
  resolveWindowsCodexLaunchCommand,
  resolveWindowsCodexSibling,
} from "../codex-windows-launch";

const NVM = "C:\\nvm4w\\nodejs";

function existsIn(files: string[]): (candidate: string) => boolean {
  const lower = new Set(files.map((file) => file.toLowerCase()));
  return (candidate) => lower.has(candidate.toLowerCase());
}

describe("resolveWindowsCodexSibling", () => {
  it("maps the extensionless npm sh shim to its .cmd sibling", () => {
    expect(
      resolveWindowsCodexSibling({
        command: `${NVM}\\codex`,
        exists: existsIn([`${NVM}\\codex.cmd`]),
      }),
    ).toBe(`${NVM}\\codex.cmd`);
  });

  it("maps a PowerShell shim to its .cmd sibling", () => {
    expect(
      resolveWindowsCodexSibling({
        command: `${NVM}\\codex.ps1`,
        exists: existsIn([`${NVM}\\codex.cmd`, `${NVM}\\codex.ps1`]),
      }),
    ).toBe(`${NVM}\\codex.cmd`);
  });

  it("prefers a real .exe over the .cmd shim", () => {
    expect(
      resolveWindowsCodexSibling({
        command: `${NVM}\\codex.ps1`,
        exists: existsIn([`${NVM}\\codex.cmd`, `${NVM}\\codex.exe`]),
      }),
    ).toBe(`${NVM}\\codex.exe`);
  });

  it("leaves an already-spawnable command alone", () => {
    expect(
      resolveWindowsCodexSibling({
        command: `${NVM}\\codex.cmd`,
        exists: existsIn([`${NVM}\\codex.cmd`]),
      }),
    ).toBeUndefined();
  });

  it("does not guess siblings for a bare command name", () => {
    // Resolution is relative to cwd for a bare name, which would silently
    // launch whatever sits in the working directory.
    expect(
      resolveWindowsCodexSibling({
        command: "codex",
        exists: () => true,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no sibling exists", () => {
    expect(
      resolveWindowsCodexSibling({
        command: `${NVM}\\codex.ps1`,
        exists: existsIn([`${NVM}\\codex.ps1`]),
      }),
    ).toBeUndefined();
  });
});

describe("isWindowsSpawnableCommand", () => {
  it("rejects .ps1 and accepts the launchable extensions", () => {
    expect(isWindowsSpawnableCommand("codex.ps1")).toBe(false);
    expect(isWindowsSpawnableCommand("codex")).toBe(false);
    expect(isWindowsSpawnableCommand("codex.cmd")).toBe(true);
    expect(isWindowsSpawnableCommand("codex.EXE")).toBe(true);
  });
});

describe("resolveWindowsCodexLaunchCommand", () => {
  it("redirects a .ps1 launch to the .cmd sibling on win32", () => {
    expect(
      resolveWindowsCodexLaunchCommand({
        command: `${NVM}\\codex.ps1`,
        exists: existsIn([`${NVM}\\codex.cmd`]),
        platform: "win32",
      }),
    ).toBe(`${NVM}\\codex.cmd`);
  });

  it("never rewrites off Windows", () => {
    expect(
      resolveWindowsCodexLaunchCommand({
        command: "/usr/local/bin/codex",
        exists: () => true,
        platform: "darwin",
      }),
    ).toBe("/usr/local/bin/codex");
  });

  it("passes a .ps1 through unchanged when nothing else is installed", () => {
    // Better to fail loudly at spawn than to invent a path that is not there.
    expect(
      resolveWindowsCodexLaunchCommand({
        command: `${NVM}\\codex.ps1`,
        exists: () => false,
        platform: "win32",
      }),
    ).toBe(`${NVM}\\codex.ps1`);
  });
});
