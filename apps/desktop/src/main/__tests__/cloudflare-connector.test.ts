import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const discovery = vi.hoisted(() => ({
  found: undefined as { command: string; version: string } | undefined,
  calls: 0,
  options: undefined as { autoCandidates: Array<{ command: string }> } | undefined,
}));

vi.mock("../settings/command-discovery", () => ({
  discoverCommands: async (options: typeof discovery.options) => {
    discovery.calls += 1;
    discovery.options = options;
    return {
      candidates: discovery.found ? [{ ...discovery.found, selected: true }] : [],
    };
  },
}));

import { CloudflareConnector } from "../federation/cloudflare-connector";

afterEach(() => {
  vi.useRealTimers();
  discovery.found = undefined;
  discovery.calls = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cloudflared discovery", () => {
  it("searches both Homebrew prefixes when the macOS app has only the system PATH", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    const connector = new CloudflareConnector();
    await connector.installed();
    expect(discovery.options?.autoCandidates.map(({ command }) => command)).toEqual([
      "cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/opt/local/bin/cloudflared",
    ]);
  });
  // Discovery tries to run cloudflared. A client machine has none, and its
  // setup pane reads status every second while a sign-in waits.
  it("looks for a missing connector at most every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const connector = new CloudflareConnector();
    expect(await connector.installed()).toBe(false);
    expect(await connector.installed()).toBe(false);
    expect(await connector.version()).toBeUndefined();
    expect(discovery.calls).toBe(1);
    vi.advanceTimersByTime(30_001);
    expect(await connector.installed()).toBe(false);
    expect(discovery.calls).toBe(2);
  });

  it("finds a connector installed since, when asked to look again", async () => {
    const connector = new CloudflareConnector();
    expect(await connector.installed()).toBe(false);
    discovery.found = { command: "/opt/homebrew/bin/cloudflared", version: "2026.9.0" };
    expect(await connector.version({ refresh: true })).toBe("2026.9.0");
    expect(await connector.installed()).toBe(true);
  });
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, killed: false, stderr: new PassThrough(),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0, null); return true; }),
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  discovery.found = { command: "/opt/homebrew/bin/cloudflared", version: "2026.9.1" };
  return child;
}

describe("cloudflared readiness", () => {
  it("requires this child's readiness check, follows connection loss, and clears on stop", async () => {
    const child = fakeChild();
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const connector = new CloudflareConnector();
    await connector.start("secret-token");
    expect(connector.running()).toBe(true);
    expect((await connector.health()).state).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    const line = JSON.stringify({ message: "Starting metrics server on 127.0.0.1:54321/metrics" });
    child.stderr.write(line.slice(0, 20));
    child.stderr.write(`${line.slice(20)}\n`);
    expect((await connector.health()).state).toBe("connected");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:54321/ready", expect.objectContaining({ redirect: "error" }));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await connector.health()).state).toBe("connecting");
    fetcher.mockRejectedValueOnce(new Error("timeout"));
    expect((await connector.health()).state).toBe("unavailable");
    const [, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
    // --output is a global flag. The nonexistent --logformat flag prints help
    // and exits zero, so a successful spawn cannot validate this CLI contract.
    expect(args).toEqual(["--output", "json", "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "run"]);
    expect(args).not.toContain("secret-token");
    expect(options?.env?.TUNNEL_TOKEN).toBe("secret-token");
    await connector.stop();
    expect((await connector.health()).state).toBe("stopped");
  });

  it("does not report stale success after the child exits during a check", async () => {
    const child = fakeChild();
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const connector = new CloudflareConnector();
    await connector.start("secret");
    child.stderr.write('{"message":"Starting metrics server on 127.0.0.1:54321/metrics"}\n');
    const checking = connector.health();
    child.emit("exit", 1, null);
    resolve(new Response(null, { status: 200 }));
    expect((await checking).state).toBe("stopped");
    expect(await connector.health()).toEqual({ state: "failed", detail: expect.stringContaining("exited (1)") });
  });

  it("ignores oversized output and non-loopback metrics addresses", async () => {
    const child = fakeChild();
    const connector = new CloudflareConnector();
    await connector.start("secret");
    child.stderr.write("x".repeat(20_000));
    child.stderr.write('\n{"message":"Starting metrics server on evil.example:80/metrics"}\n');
    expect((await connector.health()).state).toBe("unavailable");
    child.stderr.write('{"message":"Starting metrics server on 127.0.0.1:54321/metrics"}\n');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    expect((await connector.health()).state).toBe("connected");
    await connector.stop();
  });
});
