import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { resolveWindowsBashShell } from "../windows-shell";

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

async function runWrappedCommand(params: {
  args: [string, string];
  command: string;
  cwd: string;
}): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  const wrapped = wrapCommandInWindowsJob({
    ...params,
    env: process.env,
  });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: params.cwd,
        env: wrapped.env,
        windowsHide: true,
      });
      let stderr = "";
      let stdout = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stderr, stdout });
      });
    });
  } finally {
    wrapped.cleanup();
  }
}

describe("wrapCommandInWindowsJob", () => {
  it("launches the shell through an atomic kill-on-close Job wrapper", () => {
    const originalEnv = {
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
    };
    const command = [
      "set -e",
      'printf "quoted value"',
      "while true; do sleep 1; done",
    ].join("\n");

    const wrapped = wrapCommandInWindowsJob({
      args: ["-lc", command],
      command: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      cwd: "C:\\work tree",
      env: originalEnv,
    });

    expect(wrapped.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(wrapped.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    const wrapperScript = readFileSync(wrapped.args.at(-1)!, "utf8");
    expect(wrapperScript).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(wrapperScript).toContain("CREATE_SUSPENDED | CREATE_NO_WINDOW");
    expect(wrapperScript).toContain("AssignProcessToJobObject");
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_EXECUTABLE).toBe(
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    );
    expect(
      decodeBase64(wrapped.env.PWRAGENT_JOB_WRAPPER_ARGUMENT_0!),
    ).toBe("-lc");
    expect(
      decodeBase64(wrapped.env.PWRAGENT_JOB_WRAPPER_ARGUMENT_1!),
    ).toBe(
      [
        "trap 'pwragent_exit=$?; trap - EXIT; printf \"%s\" \"$pwragent_exit\" > \"$PWRAGENT_JOB_WRAPPER_EXIT_FILE\"; exit \"$pwragent_exit\"' EXIT",
        command,
      ].join("\n"),
    );
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_CWD).toBe("C:\\work tree");
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_READY_FILE).toBe(
      wrapped.readyFilePath,
    );
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_EXIT_FILE).toMatch(
      /pwragent-windows-job-.*[\\/]exit$/,
    );
    expect(originalEnv).toEqual({
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
    });
    wrapped.cleanup();
  });

  it.skipIf(process.platform !== "win32")(
    "executes both native and Git Bash commands inside the Job",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-windows-job-test-"),
      );
      try {
        const nativeResult = await runWrappedCommand({
          args: ["/c", "echo job-native"],
          command: path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "cmd.exe",
          ),
          cwd: root,
        });
        expect(nativeResult, nativeResult.stderr).toMatchObject({
          code: 0,
          stderr: "",
        });
        expect(nativeResult.stdout).toContain("job-native");

        const bashResult = await runWrappedCommand({
          args: [
            "-lc",
            [
              '[ -s "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
              '[ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
              '[ -z "${NVM_DIR:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"',
              "set -e",
              ": pwragent-env-integration-test",
              'printf "job-bash"',
            ].join("\n"),
          ],
          command: resolveWindowsBashShell(),
          cwd: root,
        });
        expect(bashResult, bashResult.stderr).toMatchObject({
          code: 0,
          stderr: "",
          stdout: "job-bash",
        });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
