import { afterEach, describe, expect, it, vi } from "vitest";

const discovery = vi.hoisted(() => ({
  found: undefined as { command: string; version: string } | undefined,
  calls: 0,
}));

vi.mock("../settings/command-discovery", () => ({
  discoverCommands: async () => {
    discovery.calls += 1;
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
});

describe("cloudflared discovery", () => {
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
