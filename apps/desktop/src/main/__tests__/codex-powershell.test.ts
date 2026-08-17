import { describe, expect, it, vi } from "vitest";
import {
  createCodexCommandInvocation,
  discoverCodexPowerShellCandidates,
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
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
