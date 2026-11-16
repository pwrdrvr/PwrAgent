import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareComputerUseMcpServer } from "../codex-app-server/computer-use-runtime";

it.skipIf(process.platform === "win32")("uses the selected Node as the real immediate parent, preserving argv, env, stdout and exit status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "computer-use-parent-"));
  try {
    const node = path.join(directory, "node");
    const nodeRepl = path.join(directory, "node_repl");
    await symlink(process.execPath, node);
    await writeFile(nodeRepl, `#!${process.execPath}\nconsole.log(JSON.stringify({parent:process.ppid,args:process.argv.slice(2),value:process.env.PARENT_TEST_VALUE}));process.exitCode=7;\n`);
    await chmod(nodeRepl, 0o755);
    const adapted = prepareComputerUseMcpServer({
      command: nodeRepl,
      args: ["a b", "$(literal)", "📎"],
      env: { NODE_REPL_NODE_PATH: node, PARENT_TEST_VALUE: "preserved" },
    })!;
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: unknown; pid: number | undefined }>((resolve) => {
      const child = execFile(adapted.command as string, adapted.args as string[], {
        env: { ...process.env, ...adapted.env as Record<string, string> },
      }, (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error?.code, pid: child.pid }));
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ parent: result.pid, args: ["a b", "$(literal)", "📎"], value: "preserved" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
