import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CloudflareGateway } from "../federation/cloudflare-gateway";
import { CloudflareOriginProbes } from "../federation/cloudflare-origin-probes";
import type { CloudflareSetupState } from "../federation/cloudflare-setup-service";
import type { CloudflareProbeRequest, CloudflareProbeResponse } from "../federation/cloudflare-security-validation";

function harness() {
  const state: CloudflareSetupState = {
    version: 1, gate: "service-token", accountId: "account", zoneId: "zone", zoneName: "example.com",
    hostname: "gateway.example.com", listenPort: 47830, name: "gateway", clients: [],
    dnsId: "dns", tunnelId: "tunnel", tunnelToken: "tunnel-secret",
    verifier: { id: "verifier", label: "Verifier", expiresAt: "2036-01-01", revoked: false,
      clientId: "validator", clientSecret: "validator-secret" },
  };
  let enabled = true;
  let probes: CloudflareOriginProbes | undefined = new CloudflareOriginProbes();
  const connector = { running: vi.fn(() => false), start: vi.fn(async (_token: string) => {}), stop: vi.fn(async () => {}) };
  const request = vi.fn(async (input: CloudflareProbeRequest): Promise<CloudflareProbeResponse> => ({
    status: 204, ray: "test-ray", proof: probes?.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage),
  }));
  const gateway = new CloudflareGateway({ load: async () => state, enabled: () => enabled, probes: () => probes, connector, request });
  return { gateway, connector, request, state, disable: () => { enabled = false; }, removeListener: () => { probes = undefined; } };
}

describe("Cloudflare gateway ownership", () => {
  it("recognizes a working external tunnel without launching or stopping its service", async () => {
    const h = harness();
    await h.gateway.start();
    expect(h.connector.start).not.toHaveBeenCalled();
    expect(await h.gateway.status()).toMatchObject({ state: "connected", connector: "external" });
    expect(h.request).toHaveBeenCalledOnce(); // Cached for pane polling.
    expect(JSON.stringify(await h.gateway.status())).not.toContain("secret");
  });

  it("starts the owned connector when the public endpoint does not reach this gateway", async () => {
    const h = harness();
    h.request.mockResolvedValue({ status: 403 });
    await h.gateway.start();
    expect(h.connector.start).toHaveBeenCalledWith("tunnel-secret");
    h.connector.running.mockReturnValue(true);
    expect(await h.gateway.status()).toMatchObject({ state: "unreachable", connector: "pwragent" });
  });

  it("rejects a response from another origin even if it returns 204", async () => {
    const h = harness();
    h.request.mockResolvedValue({ status: 204, proof: "another-origin" });
    expect(await h.gateway.status()).toMatchObject({ state: "unreachable" });
  });

  it("refreshes cached connectivity on an explicit check", async () => {
    const h = harness();
    expect((await h.gateway.status()).state).toBe("connected");
    h.request.mockRejectedValue(new Error("network down"));
    expect((await h.gateway.status(true)).state).toBe("unreachable");
  });

  it("does not probe or start when disabled, and only stops the owned child", async () => {
    const h = harness();
    h.disable();
    await h.gateway.stop();
    expect(await h.gateway.status()).toEqual({ state: "disabled", connector: "none" });
    await expect(h.gateway.start()).rejects.toThrow("Enable Cloudflare Access");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.connector.start).not.toHaveBeenCalled();
    expect(h.connector.stop).toHaveBeenCalledOnce();
  });

  it("does not launch after being stopped during external tunnel detection", async () => {
    const h = harness();
    let resolve!: (response: CloudflareProbeResponse) => void;
    h.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const starting = h.gateway.start();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    await h.gateway.stop();
    resolve({ status: 503 });
    await starting;
    expect(h.connector.start).not.toHaveBeenCalled();
  });

  it("invalidates cached success when the listener is gone", async () => {
    const h = harness();
    expect((await h.gateway.status()).state).toBe("connected");
    h.removeListener();
    expect((await h.gateway.status()).state).toBe("listener-unavailable");
    await expect(h.gateway.start()).rejects.toThrow("saved origin port");
    expect(h.connector.start).not.toHaveBeenCalled();
  });
});
