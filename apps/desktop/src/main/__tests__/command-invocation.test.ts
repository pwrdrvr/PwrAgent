import { execFile as execFileCallback } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCommandInvocation } from "../command-invocation";

const execFile = promisify(execFileCallback);

describe("createCommandInvocation", () => {
  it("preserves direct argv launches for native executables", () => {
    expect(
      createCommandInvocation({
        command: "C:\\tools\\codex.exe",
        args: ["app-server", "value & whoami"],
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\tools\\codex.exe",
      args: ["app-server", "value & whoami"],
    });
  });

  it("escapes Windows batch commands and arguments for ComSpec", () => {
    const invocation = createCommandInvocation({
      command: "C:\\nvm4w & tools\\nodejs\\codex.cmd",
      args: ["app-server", "value & whoami"],
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
    });

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain(
      "C:\\nvm4w^ ^&^ tools\\nodejs\\codex.cmd",
    );
    expect(invocation.args[3]).toContain("^\"value^ ^&^ whoami^\"");
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "executes an npm-style batch shim without evaluating argument metacharacters",
    async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-shim-&-"));
      try {
        const scriptPath = path.join(tempDir, "codex.js");
        const shimPath = path.join(tempDir, "codex.cmd");
        const injectedFile = path.join(tempDir, "injected.txt");
        writeFileSync(
          scriptPath,
          "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
          "utf8",
        );
        writeFileSync(
          shimPath,
          "@ECHO off\r\n\"%NODE_EXE%\" \"%~dp0\\codex.js\" %*\r\n",
          "utf8",
        );
        const injectionShapedArgument = `value & echo injected > ${injectedFile}`;
        const env = {
          ...process.env,
          NODE_EXE: process.execPath,
        };
        const invocation = createCommandInvocation({
          command: shimPath,
          args: ["app-server", injectionShapedArgument],
          env,
        });

        const result = await execFile(invocation.command, invocation.args, {
          env,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });

        expect(JSON.parse(result.stdout)).toEqual([
          "app-server",
          injectionShapedArgument,
        ]);
        expect(existsSync(injectedFile)).toBe(false);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
