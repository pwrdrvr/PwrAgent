import { describe, expect, it, vi } from "vitest";
import {
  discoverWindowsCodexCandidates,
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

describe("discoverWindowsCodexCandidates", () => {
  it("probes the .cmd sibling of an unusable PATH hit", async () => {
    const runner = vi.fn(
      async (_command: string, _args: string[]) => ({
        stdout: "codex-cli 0.146.0\n",
      }),
    );

    const candidates = await discoverWindowsCodexCandidates({
      candidates: [
        {
          command: `${NVM}\\codex`,
          executable: false,
          failureReason: "not_executable",
          selected: false,
          source: "path",
        },
      ],
      env: { Path: NVM },
      exists: existsIn([`${NVM}\\codex.cmd`]),
      runner,
    });

    expect(candidates).toEqual([
      {
        command: `${NVM}\\codex.cmd`,
        executable: true,
        selected: false,
        source: "path",
        version: "0.146.0",
      },
    ]);
    // cmd.exe wrapper, never powershell.exe.
    expect(runner.mock.calls[0]?.[0]).toMatch(/cmd\.exe$/i);
  });

  it("keeps the source of the candidate it was derived from", async () => {
    const candidates = await discoverWindowsCodexCandidates({
      candidates: [],
      configuredCommand: `${NVM}\\codex.ps1`,
      env: {},
      exists: existsIn([`${NVM}\\codex.cmd`]),
      runner: async () => ({ stdout: "codex-cli 0.146.0\n" }),
    });

    expect(candidates).toMatchObject([
      { command: `${NVM}\\codex.cmd`, source: "config" },
    ]);
  });

  it("reports a sibling-less PowerShell shim as unsupported", async () => {
    const runner = vi.fn();

    const candidates = await discoverWindowsCodexCandidates({
      candidates: [],
      configuredCommand: `${NVM}\\codex.ps1`,
      env: {},
      exists: existsIn([`${NVM}\\codex.ps1`]),
      runner,
    });

    expect(candidates).toEqual([
      {
        command: `${NVM}\\codex.ps1`,
        executable: false,
        failureReason: "powershell_shim_unsupported",
        selected: false,
        source: "config",
      },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not re-probe a command shared discovery already returned", async () => {
    const runner = vi.fn();

    const candidates = await discoverWindowsCodexCandidates({
      candidates: [
        {
          command: `${NVM}\\codex.cmd`,
          executable: true,
          selected: true,
          source: "path",
          version: "0.146.0",
        },
        { command: `${NVM}\\codex`, executable: false, selected: false, source: "path" },
      ],
      env: {},
      exists: existsIn([`${NVM}\\codex.cmd`]),
      runner,
    });

    expect(candidates).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports a timeout, but not an external kill, as timed out", async () => {
    // Node sets `killed` only when it terminated the child itself. An EDR or
    // Defender kill arrives with the same SIGTERM but killed:false, and
    // calling that a timeout sends the operator after a latency problem that
    // is not there.
    const timedOut = Object.assign(new Error("Command failed"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
    const externallyKilled = Object.assign(new Error("Command failed"), {
      code: null,
      killed: false,
      signal: "SIGTERM",
    });

    const run = async (error: unknown) =>
      await discoverWindowsCodexCandidates({
        candidates: [],
        configuredCommand: `${NVM}\\codex.ps1`,
        env: {},
        exists: existsIn([`${NVM}\\codex.cmd`]),
        runner: async () => {
          throw error;
        },
      });

    expect(await run(timedOut)).toMatchObject([
      { failureReason: "version_probe_timed_out" },
    ]);
    expect(await run(externallyKilled)).toMatchObject([
      { failureReason: "Command failed" },
    ]);
  });

  it("re-probes a sibling that shared discovery left unvalidated", async () => {
    // The plain npm-global layout: upstream's short probe times out and leaves
    // the .cmd executable-but-versionless. That row must not suppress the
    // re-probe on this module's longer budget.
    const runner = vi.fn(async () => ({ stdout: "codex-cli 0.146.0\n" }));

    const candidates = await discoverWindowsCodexCandidates({
      candidates: [
        { command: `${NVM}\\codex`, executable: false, selected: false, source: "path" },
        {
          command: `${NVM}\\codex.cmd`,
          executable: true,
          selected: false,
          source: "application",
          versionFailureReason: "version_not_reported",
        },
      ],
      env: {},
      exists: existsIn([`${NVM}\\codex.cmd`]),
      runner,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(candidates).toMatchObject([
      { command: `${NVM}\\codex.cmd`, executable: true, version: "0.146.0" },
    ]);
  });

  it("surfaces a spawn failure as the candidate's failure reason", async () => {
    const error = Object.assign(new Error("spawn EPERM"), { code: "EPERM" });

    const candidates = await discoverWindowsCodexCandidates({
      candidates: [],
      configuredCommand: `${NVM}\\codex.ps1`,
      env: {},
      exists: existsIn([`${NVM}\\codex.cmd`]),
      runner: async () => {
        throw error;
      },
    });

    expect(candidates).toMatchObject([
      { command: `${NVM}\\codex.cmd`, executable: false, failureReason: "spawn EPERM" },
    ]);
  });
});
