import { spawn } from "node:child_process";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import {
  collectDescendants,
  parseProcessTable,
  readProcessTable,
  reapSurvivingDescendants,
  type ProcessTableEntry,
} from "../process-descendants";
import { terminateOwnedProcessTree } from "../process-tree";

describe("process table helpers", () => {
  it("parses ps output, keeping commands with spaces", () => {
    expect(parseProcessTable([
      "    1     0 /sbin/launchd",
      "  700   600 /Applications/PwrAgent.app/Contents/MacOS/PwrAgent out/main/mcp-connection-bridge.js",
      "  701   600",
      "garbage",
    ].join("\n"))).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      {
        pid: 700,
        ppid: 600,
        command: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent out/main/mcp-connection-bridge.js",
      },
      { pid: 701, ppid: 600, command: "" },
    ]);
  });

  it("collects every descendant, not only direct children", () => {
    const table: ProcessTableEntry[] = [
      { pid: 600, ppid: 1, command: "codex app-server" },
      { pid: 700, ppid: 600, command: "npm exec context7" },
      { pid: 701, ppid: 700, command: "node context7" },
      { pid: 702, ppid: 600, command: "node_repl" },
      { pid: 800, ppid: 1, command: "unrelated" },
    ];
    expect(collectDescendants(table, 600).map((entry) => entry.pid)).toEqual([700, 702, 701]);
    expect(collectDescendants(table, 999)).toEqual([]);
  });

  it("signals only survivors that still run their recorded command", async () => {
    const snapshot: ProcessTableEntry[] = [
      { pid: 700, ppid: 600, command: "node mcp-connection-bridge.js" },
      { pid: 701, ppid: 600, command: "node_repl" },
      { pid: 702, ppid: 600, command: "npm exec context7" },
    ];
    let table: ProcessTableEntry[] = [
      // Outlived the group stop.
      { pid: 700, ppid: 1, command: "node mcp-connection-bridge.js" },
      // The pid now belongs to something else.
      { pid: 701, ppid: 1, command: "/usr/bin/vim" },
      // 702 stopped with the group.
    ];
    const signals: Array<[number, NodeJS.Signals]> = [];
    const reaped = await reapSurvivingDescendants(snapshot, {
      readTable: async () => table,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") table = table.filter((entry) => entry.pid !== pid);
      },
      pollIntervalMs: 1,
    });
    expect(reaped).toBe(1);
    expect(signals).toEqual([[700, "SIGTERM"]]);
  });

  it("escalates to SIGKILL when a survivor ignores SIGTERM", async () => {
    const snapshot: ProcessTableEntry[] = [{ pid: 700, ppid: 600, command: "stubborn" }];
    let table: ProcessTableEntry[] = [{ pid: 700, ppid: 1, command: "stubborn" }];
    const signals: Array<[number, NodeJS.Signals]> = [];
    await reapSurvivingDescendants(snapshot, {
      readTable: async () => table,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") table = [];
      },
      gracefulTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    expect(signals).toEqual([[700, "SIGTERM"], [700, "SIGKILL"]]);
  });

  it.skipIf(process.platform === "win32")(
    "kills a real descendant that left the server's process group",
    async () => {
      // The parent leads its own group, like the app server; its child starts
      // a new session, like an MCP server launched through a wrapper.
      const parent = spawn(process.execPath, ["-e", [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
        "  { detached: true, stdio: 'ignore' });",
        "process.stdout.write(child.pid + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n")], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const escapedPid = await new Promise<number>((resolve) => {
        readline.createInterface({ input: parent.stdout! })
          .once("line", (line) => resolve(Number(line)));
      });
      const running = async (pid: number) =>
        (await readProcessTable())?.find((entry) => entry.pid === pid);
      try {
        const descendants = collectDescendants((await readProcessTable())!, parent.pid!);
        expect(descendants.map((entry) => entry.pid)).toContain(escapedPid);

        await terminateOwnedProcessTree(parent, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 2_000 });
        const escaped = await running(escapedPid);
        expect(escaped?.command).toBe(descendants.find((entry) => entry.pid === escapedPid)?.command);

        expect(await reapSurvivingDescendants(descendants, { pollIntervalMs: 20 })).toBe(1);
        // A zombie awaiting its new parent reports another command, or none.
        await vi.waitFor(async () => expect((await running(escapedPid))?.command)
          .not.toBe(escaped?.command));
      } finally {
        try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
        try { process.kill(-parent.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
    },
  );
});
