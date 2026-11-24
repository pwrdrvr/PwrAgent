import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor";
import { readAntigravityUsage } from "../acp/antigravity-usage";
import type { OwnedChildProcess } from "../process-tree";

function launchDescriptor(command: string): AcpLaunchDescriptor {
  // Override the inherited key with the same spelling so the merged
  // environment doesn't give the launcher two case variants to choose from.
  const comSpecKey = Object.keys(process.env).find((key) => key.toLowerCase() === "comspec") ?? "ComSpec";
  return {
    backendId: "acp:antigravity",
    registryId: "antigravity",
    distributionKind: "local",
    command,
    args: ["acp", "--process-per-session"],
    env: { [comSpecKey]: "C:\\Windows\\System32\\cmd.exe" },
  };
}

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    pid: 42,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => true,
  });
}

const VERSION_ARGS = ["--version"];
const USAGE_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "15s"];

describe("Antigravity quota commands", () => {
  it("invokes each Windows command with the same argv and shim quoting as the ACP launcher", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(".cmd", ".bat", ".CMD", ".exe"), async (extension) => {
      const launch = launchDescriptor(`C:\\Program Files\\Antigravity\\agy${extension}`);
      const outputs = [
        "1.5.14\n",
        JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [
          { name: "Gemini Models", buckets: [{ id: "weekly", window: "weekly", remaining_fraction: 0.5 }] },
        ] } } }),
      ];
      const spawn = vi.fn(() => {
        const child = childProcess();
        queueMicrotask(() => {
          child.stdout.write(outputs.shift() ?? "");
          child.exitCode = 0;
          child.emit("close", 0);
        });
        return child;
      });
      const result = await readAntigravityUsage(launch, new AbortController().signal, {
        platform: "win32",
        spawn,
        terminate: async () => undefined,
      });
      expect(result?.rateLimits?.[0]?.usedPercent).toBe(50);
      const calls = [VERSION_ARGS, USAGE_ARGS].map((args) => {
        const invocation = createCommandInvocation({ ...launch, args, platform: "win32" });
        return [invocation.command, invocation.args, expect.objectContaining({
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        })];
      });
      expect(spawn.mock.calls).toEqual(calls);
    }), { numRuns: 16 });
  });

  it("stops and drains the running command before returning from an aborted quota read", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (abortDuringVersion) => {
      const launch = launchDescriptor("C:\\Antigravity\\agy.cmd");
      const controller = new AbortController();
      const cleanup = Promise.withResolvers<void>();
      const childStarted = Promise.withResolvers<ReturnType<typeof childProcess>>();
      let activeChild: ReturnType<typeof childProcess> | undefined;
      const spawn = vi.fn(() => {
        const child = childProcess();
        if (abortDuringVersion || spawn.mock.calls.length === 2) {
          activeChild = child;
          childStarted.resolve(child);
        } else {
          queueMicrotask(() => {
            child.stdout.write("1.5.14\n");
            child.exitCode = 0;
            child.emit("close", 0);
          });
        }
        return child;
      });
      const terminate = vi.fn(async (child: OwnedChildProcess) => {
        if (child === activeChild) await cleanup.promise;
      });
      const settled = vi.fn();
      const reading = readAntigravityUsage(launch, controller.signal, {
        platform: "win32",
        spawn,
        terminate,
      }).then(settled);
      try {
        const child = await Promise.race([childStarted.promise, reading.then(() => undefined)]);
        expect(child).toBeDefined();
        controller.abort();
        await vi.waitFor(() => {
          expect(terminate.mock.calls.some(([terminated]) => terminated === child)).toBe(true);
        });
        expect(settled).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledTimes(abortDuringVersion ? 1 : 2);
      } finally {
        cleanup.resolve();
        await reading;
      }
      expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
    }), { numRuns: 8 });
  });
});
