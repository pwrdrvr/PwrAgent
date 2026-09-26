import { describe, expect, it, vi } from "vitest";
import {
  FederationLocalNetworkNotice,
  federationLocalNetworkFailureHint,
  isInternalFederationAddress,
} from "../federation/federation-local-network";

function harness(overrides = {}) {
  const deps = {
    enabled: () => true,
    acknowledged: vi.fn(async () => false),
    acknowledge: vi.fn(async () => {}),
    resolve: vi.fn(async () => ["192.168.6.162"]),
    explain: vi.fn(async (_hostname: string) => {}),
    warn: vi.fn(),
    ...overrides,
  };
  return { deps, notice: new FederationLocalNetworkNotice(deps) };
}

describe("Federation local network explanation", () => {
  it.each(["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.6.162", "169.254.2.1", "fd12::1", "fe80::1", "::ffff:192.168.1.1"])("recognizes %s", (address) => {
    expect(isInternalFederationAddress(address)).toBe(true);
  });

  it.each(["127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "100.64.0.1", "2606:4700::1111", "invalid"])("does not classify %s as a LAN gateway", (address) => {
    expect(isInternalFederationAddress(address)).toBe(false);
  });

  it("explains a DNS-resolved private gateway once, without displaying URL secrets", async () => {
    const { notice, deps } = harness();
    await notice.beforeConnect("wss://user:secret@gateway.example:47830/path?token=secret", () => true);
    await notice.beforeConnect("ws://192.168.1.2", () => true);
    expect(deps.explain).toHaveBeenCalledExactlyOnceWith("gateway.example");
    expect(deps.acknowledge).toHaveBeenCalledOnce();
    expect(deps.resolve).toHaveBeenCalledOnce();
  });

  it("uses a persisted acknowledgement across launches", async () => {
    const { notice, deps } = harness({ acknowledged: vi.fn(async () => true) });
    await notice.beforeConnect("ws://gateway.example", () => true);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.explain).not.toHaveBeenCalled();
  });

  it("skips public addresses, then explains an IPv6 literal without DNS", async () => {
    const { notice, deps } = harness({ resolve: vi.fn(async () => ["8.8.8.8"]) });
    await notice.beforeConnect("wss://public.example", () => true);
    expect(deps.explain).not.toHaveBeenCalled();
    await notice.beforeConnect("ssh://[fd12::1]:22", () => true);
    expect(deps.explain).toHaveBeenCalledExactlyOnceWith("fd12::1");
    expect(deps.resolve).toHaveBeenCalledOnce();
  });

  it("does nothing on unsupported platforms", async () => {
    const { notice, deps } = harness({ enabled: () => false });
    await notice.beforeConnect("ws://192.168.1.2", () => true);
    expect(deps.acknowledged).not.toHaveBeenCalled();
  });

  it("does not show a stale prompt after stop or restart during DNS", async () => {
    let current = true;
    const { notice, deps } = harness({ resolve: vi.fn(async () => {
      current = false;
      return ["192.168.1.1"];
    }) });
    await notice.beforeConnect("ws://gateway.example", () => current);
    expect(deps.explain).not.toHaveBeenCalled();
    expect(deps.acknowledge).not.toHaveBeenCalled();
  });

  it("does not block connections on DNS failure", async () => {
    const { notice, deps } = harness({ resolve: vi.fn(async () => { throw new Error("DNS failed"); }) });
    await expect(notice.beforeConnect("ws://gateway.example", () => true)).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledOnce();
  });

  it("deduplicates overlapping attempts and retries even when saving fails", async () => {
    const { notice, deps } = harness({ acknowledge: vi.fn(async () => { throw new Error("disk full"); }) });
    await Promise.all([
      notice.beforeConnect("ws://192.168.1.2", () => true),
      notice.beforeConnect("ws://192.168.1.2", () => true),
    ]);
    await notice.beforeConnect("ws://192.168.1.2", () => true);
    expect(deps.explain).toHaveBeenCalledOnce();
    expect(deps.warn).toHaveBeenCalledOnce();
  });

  it("keeps a restarted dial behind an explanation that is still open", async () => {
    let dismiss!: () => void;
    const dialog = new Promise<void>((resolve) => { dismiss = resolve; });
    const { notice, deps } = harness({ explain: vi.fn(() => dialog) });
    const first = notice.beforeConnect("ws://192.168.1.2", () => true);
    await vi.waitFor(() => expect(deps.explain).toHaveBeenCalledOnce());
    let continued = false;
    const second = notice.beforeConnect("ws://192.168.1.2", () => true).then(() => { continued = true; });
    await Promise.resolve();
    expect(continued).toBe(false);
    dismiss();
    await Promise.all([first, second]);
    expect(continued).toBe(true);
    expect(deps.explain).toHaveBeenCalledOnce();
  });

  it("adds conditional recovery advice for macOS reachability errors only", () => {
    expect(federationLocalNetworkFailureHint("connect EHOSTUNREACH 192.168.6.162", "darwin")).toContain("routing or firewall");
    expect(federationLocalNetworkFailureHint("connect EHOSTUNREACH", "linux")).toBe("");
    expect(federationLocalNetworkFailureHint("bad gateway identity", "darwin")).toBe("");
  });
});
