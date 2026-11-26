import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor";
import { readAntigravityUsage } from "../acp/antigravity-usage";

function versionChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => true,
  });
}

describe("Antigravity quota browser suppression", () => {
  it.runIf(process.platform === "darwin")("keeps native open from reaching the inherited PATH during quota reads", async () => {
    const inheritedBin = await mkdtemp(path.join(tmpdir(), "fixture-agy-usage-open-"));
    await writeFile(path.join(inheritedBin, "open"), "#!/bin/sh\nexit 37\n", { mode: 0o700 });
    try {
      const launch: AcpLaunchDescriptor = {
        backendId: "acp:antigravity",
        registryId: "antigravity",
        distributionKind: "local",
        command: "/fake/agy",
        args: ["acp", "--process-per-session"],
        env: { PATH: inheritedBin },
      };
      let openExitStatus: number | null = null;
      const spawn = vi.fn((_command: string, args: string[], options: Parameters<typeof spawnProcess>[2]) => {
        if (args.includes("--version")) {
          const child = versionChild();
          queueMicrotask(() => {
            child.stdout.write("1.5.18\n");
            child.exitCode = 0;
            child.emit("close", 0);
          });
          return child;
        }
        const child = spawnProcess(
          process.execPath,
          ["-e", String.raw`
            const { spawnSync } = require("node:child_process");
            const opened = spawnSync("open", ["https://accounts.google.com/o/oauth2/auth?response_type=code"], { stdio: "ignore" });
            process.stdout.write(JSON.stringify({ status: "SUCCESS", openStatus: opened.status, command: { name: "usage", data: { groups: [] } } }));
          `],
          options,
        );
        child.stdout?.on("data", (chunk: Buffer) => {
          try {
            const parsed = JSON.parse(chunk.toString("utf8")) as { openStatus?: number };
            if (typeof parsed.openStatus === "number") openExitStatus = parsed.openStatus;
          } catch {
            // Wait for complete output.
          }
        });
        return child;
      });
      await readAntigravityUsage(launch, new AbortController().signal, {
        spawn,
      });
      expect(openExitStatus).toBe(0);
    } finally {
      await rm(inheritedBin, { recursive: true, force: true });
    }
  });
});
