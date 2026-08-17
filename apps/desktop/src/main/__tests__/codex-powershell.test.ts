import { describe, expect, it, vi } from "vitest";
import {
  createCodexCommandInvocation,
  discoverCodexPowerShellCandidates,
  runCodexOneShot,
} from "../codex-powershell";

describe("Codex PowerShell support", () => {
  it("launches Windows PowerShell shims with direct argv", () => {
    expect(
      createCodexCommandInvocation({
        command: "C:\\nvm4w\\nodejs\\codex.ps1",
        args: ["app-server", "value & whoami"],
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
      }),
    ).toEqual({
      command:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\nvm4w\\nodejs\\codex.ps1",
        "app-server",
        "value & whoami",
      ],
    });
  });

  it("uses Get-Command to discover and validate a PATH PowerShell shim", async () => {
    const command = "C:\\nvm4w\\nodejs\\codex.ps1";
    const runner = vi.fn(async (_executable: string, args: string[]) =>
      args.includes("-Command")
        ? { stdout: command }
        : { stdout: "codex-cli 0.144.0" },
    );

    await expect(
      discoverCodexPowerShellCandidates({
        env: { Path: "C:\\nvm4w\\nodejs", SystemRoot: "C:\\Windows" },
        runner,
      }),
    ).resolves.toEqual([
      {
        command,
        executable: true,
        selected: false,
        source: "path",
        version: "0.144.0",
      },
    ]);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("closes stdin for a one-shot Codex probe", async () => {
    const result = await runCodexOneShot(
      process.execPath,
      [
        "-e",
        "process.stdin.on('end', () => process.stdout.write('codex-cli 0.146.0')); process.stdin.resume();",
      ],
      {
        env: process.env,
        timeout: 2_000,
        windowsHide: true,
      },
    );

    expect(result.stdout?.toString()).toBe("codex-cli 0.146.0");
  });

  it("discovers the current user's Codex Desktop MSIX CLI", async () => {
    const command = [
      "C:\\Program Files\\WindowsApps",
      "OpenAI.Codex_26.810.7004.0_x64__2p2nqsd0c76g0",
      "app\\resources\\codex.exe",
    ].join("\\");
    const runner = vi.fn(async (_executable: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      if (script.includes("Get-AppxPackage")) {
        return { stdout: `${command}\r\n` };
      }
      if (script.includes("Get-Command")) {
        return { stdout: "" };
      }
      return { stdout: "codex-cli 0.146.0" };
    });

    await expect(
      discoverCodexPowerShellCandidates({
        env: { SystemRoot: "C:\\Windows" },
        includePath: false,
        runner,
      }),
    ).resolves.toEqual([
      {
        command,
        executable: true,
        selected: false,
        source: "application",
        version: "0.146.0",
      },
    ]);
  });
});
