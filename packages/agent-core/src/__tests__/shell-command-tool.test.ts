import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellCommandTool } from "../tools/shell-command-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("shell_command tool", () => {
  it("runs a safe shell read command without approval", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.writeFile(path.join(workspace.path, "needle.txt"), "SAFE_NEEDLE\n", "utf8");
    const tool = createShellCommandTool();

    const result = await tool.execute(
      tool.parseArguments({ command: "grep -rn SAFE_NEEDLE ." }),
      { cwd: workspace.path, approvalPolicy: "on-request" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        commandAction: "search",
        itemType: "commandExecution",
        command: "grep -rn SAFE_NEEDLE .",
      }),
    );
    expect(result.output).toContain("needle.txt:1:SAFE_NEEDLE");
  });

  it("requests approval for unsafe commands and does not run when declined", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createShellCommandTool();
    const requestApproval = vi.fn(async () => ({ decision: "decline" }));

    const result = await tool.execute(
      tool.parseArguments({ command: "touch created.txt" }),
      {
        cwd: workspace.path,
        approvalPolicy: "on-request",
        requestApproval,
      },
    );

    await expect(fs.stat(path.join(workspace.path, "created.txt"))).rejects.toThrow();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "commandExecution",
        command: "touch created.txt",
      }),
    );
    expect(result).toEqual({
      success: false,
      output: "Approval declined for shell_command: touch created.txt",
      commandAction: "unknown",
      itemType: "commandExecution",
      command: "touch created.txt",
    });
  });

  it("runs an approved unsafe command and applies the side effect", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createShellCommandTool();
    const requestApproval = vi.fn(async () => ({ decision: "approve" }));

    const result = await tool.execute(
      tool.parseArguments({ command: "touch created.txt" }),
      {
        cwd: workspace.path,
        approvalPolicy: "on-request",
        requestApproval,
      },
    );

    await expect(fs.stat(path.join(workspace.path, "created.txt"))).resolves.toBeTruthy();
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        output: "Command executed successfully (no output).",
        data: expect.objectContaining({
          exitCode: 0,
          status: "completed",
        }),
        commandAction: "unknown",
        itemType: "commandExecution",
        command: "touch created.txt",
      }),
    );
  });

  it("completes high-output commands without maxBuffer failures", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createShellCommandTool();
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('A'.repeat(11 * 1024 * 1024))"`;

    const result = await tool.execute(
      tool.parseArguments({ command }),
      { cwd: workspace.path, approvalPolicy: "never" },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("output truncated");
    expect(result.data).toEqual(
      expect.objectContaining({
        exitCode: 0,
        status: "completed",
        stdoutTruncated: true,
      }),
    );
  });

  it("emits shell output deltas before command completion", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createShellCommandTool();
    const deltas: string[] = [];
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('first'); process.stderr.write('second')"`;

    const result = await tool.execute(
      tool.parseArguments({ command }),
      {
        cwd: workspace.path,
        approvalPolicy: "never",
        onOutputDelta: (delta) => {
          deltas.push(`${delta.stream}:${delta.text}`);
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("first");
    expect(result.output).toContain("STDERR: second");
    expect(deltas.join("|")).toContain("stdout:first");
    expect(deltas.join("|")).toContain("stderr:second");
  });
});
