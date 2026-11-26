import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor";
import { readAntigravityUsage } from "../acp/antigravity-usage";
import type { OwnedChildProcess } from "../process-tree";

function launchDescriptor(command: string, env: Record<string, string> = {}): AcpLaunchDescriptor {
  // Override the inherited key with the same spelling so the merged
  // environment doesn't give the launcher two case variants to choose from.
  const comSpecKey = Object.keys(process.env).find((key) => key.toLowerCase() === "comspec") ?? "ComSpec";
  return {
    backendId: "acp:antigravity",
    registryId: "antigravity",
    distributionKind: "local",
    command,
    args: ["acp", "--process-per-session"],
    env: { [comSpecKey]: "C:\\Windows\\System32\\cmd.exe", ...env },
  };
}

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
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

  it("suppresses interactive browser launchers across platforms and inherited browser env vars", async () => {
    const authUrl = "https://accounts.google.com/o/oauth2/auth?response_type=code";
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("darwin" as const, "linux" as const, "win32" as const),
      fc.record({
        display: fc.option(fc.constantFrom(":0", ":99"), { nil: undefined }),
        wayland: fc.option(fc.constantFrom("wayland-0"), { nil: undefined }),
        browser: fc.option(fc.constantFrom("/usr/bin/firefox", "open"), { nil: undefined }),
      }),
      async (platform, inherited) => {
        const extraEnv: Record<string, string> = {};
        if (inherited.display) extraEnv.DISPLAY = inherited.display;
        if (inherited.wayland) extraEnv.WAYLAND_DISPLAY = inherited.wayland;
        if (inherited.browser) extraEnv.BROWSER = inherited.browser;
        const launch = launchDescriptor(
          platform === "win32" ? "C:\\Antigravity\\agy.exe" : "/fake/agy",
          extraEnv,
        );
        const outputs = [
          "1.5.18\n",
          JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }),
        ];
        const observedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
        let shimVerified = platform === "win32";
        const spawn = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          observedEnvs.push(options.env);
          const child = childProcess();
          const isUsage = args.includes("/usage") || args.some((arg) => arg.includes("/usage"));
          const checkShim = isUsage && (platform === "darwin" || platform === "linux")
            ? (async () => {
                const pathValue = process.platform === "win32"
                  ? options.env?.PATH
                    ?? Object.entries(options.env ?? {})
                      .find(([key]) => key.toUpperCase() === "PATH")?.[1]
                    ?? ""
                  : options.env?.PATH ?? "";
                const firstPath = pathValue.split(path.delimiter)[0];
                const shimName = platform === "darwin" ? "open" : "xdg-open";
                if (firstPath) {
                  await access(path.join(firstPath, shimName), constants.X_OK);
                  shimVerified = true;
                }
              })().catch(() => {
                shimVerified = false;
              })
            : Promise.resolve();
          void checkShim.then(() => {
            child.stdout.write(outputs.shift() ?? authUrl);
            child.exitCode = 0;
            child.emit("close", 0);
          });
          return child;
        });
        await readAntigravityUsage(launch, new AbortController().signal, {
          platform,
          spawn,
          terminate: async () => undefined,
        });
        expect(spawn).toHaveBeenCalledTimes(2);
        const usageEnv = observedEnvs[1] ?? {};
        const keys = Object.keys(usageEnv).map((key) => key.toUpperCase());
        expect(keys).not.toContain("DISPLAY");
        expect(keys).not.toContain("WAYLAND_DISPLAY");
        expect(usageEnv.SSH_CONNECTION).toBeTruthy();
        expect(usageEnv.BROWSER).toBeTruthy();
        expect(usageEnv.BROWSER).not.toBe(inherited.browser);
        expect(shimVerified).toBe(true);
      },
    ), { numRuns: 18 });
  });

  it.skipIf(process.platform === "win32")("prepends the browser shim to exact PATH on POSIX even when lowercase path precedes PATH", async () => {
    const savedPath = process.env.PATH;
    const savedLowerPath = process.env.path;
    delete process.env.PATH;
    delete process.env.path;
    process.env.path = "/unrelated/lower-path";
    process.env.PATH = savedPath ?? "/usr/bin:/bin";
    try {
      const launch = launchDescriptor("/fake/agy");
      const outputs = [
        "1.5.18\n",
        JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }),
      ];
      let exactPathShimOk = false;
      let lowerPathPreserved: string | undefined;
      const spawn = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        const child = childProcess();
        const isUsage = args.includes("/usage");
        const check = isUsage
          ? (async () => {
              lowerPathPreserved = options.env?.path;
              const firstPath = (options.env?.PATH ?? "").split(path.delimiter)[0];
              const opener = process.platform === "darwin" ? "open" : "xdg-open";
              if (firstPath) {
                await access(path.join(firstPath, opener), constants.X_OK);
                exactPathShimOk = true;
              }
            })().catch(() => {
              exactPathShimOk = false;
            })
          : Promise.resolve();
        void check.then(() => {
          child.stdout.write(outputs.shift() ?? "");
          child.exitCode = 0;
          child.emit("close", 0);
        });
        return child;
      });
      await readAntigravityUsage(launch, new AbortController().signal, {
        platform: process.platform,
        spawn,
        terminate: async () => undefined,
      });
      expect(exactPathShimOk).toBe(true);
      expect(lowerPathPreserved).toBe("/unrelated/lower-path");
    } finally {
      delete process.env.path;
      if (savedLowerPath !== undefined) process.env.path = savedLowerPath;
      if (savedPath !== undefined) process.env.PATH = savedPath;
      else delete process.env.PATH;
    }
  });

  it("aborts immediately without waiting for timeout when agy prompts for authentication on stderr", async () => {
    const authStderr =
      "Authentication required. Please visit the URL to log in:\n"
      + "  https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback\n\n"
      + "Waiting for authentication (timeout 60s)...\n"
      + "Or, paste the authorization code here and press Enter:\n";
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: authStderr.length - 1 }),
      async (splitAt) => {
        const launch = launchDescriptor("C:\\Antigravity\\agy.exe");
        let usageChild: ReturnType<typeof childProcess> | undefined;
        const spawn = vi.fn((_command: string, args: string[]) => {
          const child = childProcess();
          if (args.includes("--version")) {
            queueMicrotask(() => {
              child.stdout.write("1.5.18\n");
              child.exitCode = 0;
              child.emit("close", 0);
            });
          } else {
            usageChild = child;
            queueMicrotask(() => {
              child.stderr.write(authStderr.slice(0, splitAt));
              child.stderr.write(authStderr.slice(splitAt));
            });
          }
          return child;
        });
        const terminate = vi.fn(async () => undefined);
        const result = await readAntigravityUsage(launch, new AbortController().signal, {
          platform: "win32",
          spawn,
          terminate,
        });
        expect(result).toBeUndefined();
        expect(terminate).toHaveBeenCalledWith(usageChild, expect.anything());
      },
    ), { numRuns: 16 });
  });
});
