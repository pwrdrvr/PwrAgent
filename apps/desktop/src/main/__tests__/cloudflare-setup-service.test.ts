import { describe, expect, it, vi } from "vitest";
import { CloudflareSetupService, type CloudflareSetupState } from "../federation/cloudflare-setup-service";
import { CloudflareApi } from "../federation/cloudflare-api";
import { CloudflareOriginProbes } from "../federation/cloudflare-origin-probes";

function harness() {
  let stored: CloudflareSetupState | undefined;
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const resources = new Map<string, Record<string, unknown>>();
  let tamper = false;
  const api = new CloudflareApi("token", async (url, options) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/client/v4", "");
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    calls.push({ method, path, body });
    let result: unknown;
    if (path === `/zones/${"b".repeat(32)}`) result = { name: "example.com", status: "active", account: { id: "a".repeat(32) } };
    else if (method === "POST") {
      const id = `resource-${resources.size}`;
      result = { id, ...body, ...(path.endsWith("/certificates") ? { expires_on: "2036-01-01" } : {}), ...(path.endsWith("/cfd_tunnel") ? { token: "connector-secret" } : {}) };
      resources.set(`${path}/${id}`, result as Record<string, unknown>);
    } else if (method === "PUT") {
      result = { ...resources.get(path), ...body };
      resources.set(path, result as Record<string, unknown>);
    }
    else if (resources.has(path)) result = resources.get(path);
    else {
      result = [...resources.entries()].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
        .map(([, value]) => value);
      if (tamper && path.endsWith("/policies")) result = [{ id: stored?.policyId, decision: "bypass", include: [{ everyone: {} }] }];
    }
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
  const publishUrl = vi.fn(async () => undefined);
  const startConnector = vi.fn(async () => undefined);
  const verifyListener = vi.fn(() => new CloudflareOriginProbes());
  const service = new CloudflareSetupService({
    load: async () => stored ? structuredClone(stored) : undefined,
    save: async (state) => { stored = structuredClone(state); },
    api: () => api,
    verifyListener,
    connectorInstalled: async () => true,
    connectorRunning: () => false,
    startConnector,
    stopConnector: async () => undefined,
    publishUrl,
  });
  return { service, calls, resources, publishUrl, startConnector, verifyListener,
    tamper: () => { tamper = true; }, state: () => stored,
    connect: () => service.connect("x".repeat(40), "a".repeat(32), "b".repeat(32)),
  };
}

describe("Cloudflare provisioning", () => {
  it("creates and audits admission before DNS publication, keeps private keys out of API calls", async () => {
    const h = harness();
    await h.connect();
    await h.service.provision("federation.example.com", 47830);
    const mutations = h.calls.filter((call) => call.method === "POST");
    expect(mutations.map((call) => call.path.split("/").at(-1))).toEqual(["certificates", "apps", "policies", "cfd_tunnel", "dns_records"]);
    expect(JSON.stringify(h.calls)).not.toContain("PRIVATE KEY");
    expect(h.startConnector).toHaveBeenCalledWith("connector-secret");
    expect(h.publishUrl).toHaveBeenCalledWith("wss://federation.example.com");
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    const status = await h.service.status();
    expect(JSON.stringify(status)).not.toContain("connector-secret");
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    await h.service.provision("federation.example.com", 47830);
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(5);
  });

  it("does not publish DNS when read-back finds a bypass policy", async () => {
    const h = harness();
    await h.connect();
    h.tamper();
    await expect(h.service.provision("federation.example.com", 47830)).rejects.toThrow("audit failed");
    expect(h.calls.some((call) => call.method === "POST" && call.path.endsWith("dns_records"))).toBe(false);
    expect(h.startConnector).not.toHaveBeenCalled();
    expect(h.state()?.applicationId).toBeDefined();
  });

  it("refuses a competing wildcard Access application without changing it", async () => {
    const h = harness();
    h.resources.set(`/accounts/${"a".repeat(32)}/access/apps/existing`, { id: "existing", domain: "*.example.com" });
    await h.connect();
    await expect(h.service.provision("federation.example.com", 47830)).rejects.toThrow("already covers");
    expect(h.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("does not mutate Cloudflare without local listener ownership", async () => {
    const h = harness();
    await h.connect();
    h.verifyListener.mockImplementation(() => { throw new Error("wrong listener"); });
    await expect(h.service.provision("federation.example.com", 47830)).rejects.toThrow("wrong listener");
    expect(h.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("admits and revokes each issued client without exposing its private key", async () => {
    const h = harness();
    await h.connect();
    await h.service.provision("federation.example.com", 47830);
    const client = await h.service.issue("Travel laptop");
    expect(h.state()?.clients[0].id).toBe(client.id);
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    expect(JSON.stringify(h.calls)).not.toContain(client.privateKey);
    expect(JSON.stringify(await h.service.status())).not.toContain(client.privateKey);
    await h.service.revoke(client.id);
    expect(h.state()?.clients[0].revoked).toBe(true);
    const policyUpdate = h.calls.filter((call) => call.method === "PUT" && call.path.includes("/policies/")).at(-1);
    expect(JSON.stringify(policyUpdate?.body)).not.toContain(client.id);
    expect(JSON.stringify(policyUpdate?.body)).toContain(h.state()?.verifier.id);
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
  });
});

describe("Cloudflare API failure reporting", () => {
  const account = "a".repeat(32);
  const respond = (status: number, payload: unknown) =>
    new CloudflareApi("secret-token", async () =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));

  it("names the plan entitlement and the token scope when the CA upload is refused", async () => {
    const api = respond(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    // The operator needs to know a 403 here has two candidate causes; the old
    // message named only the token, which sends them re-scoping a token that
    // was never the problem.
    await expect(api.request(`/accounts/${account}/access/certificates`, "POST", {}))
      .rejects.toThrow(/Authentication error \(code 10000\).*Contract \(Enterprise\) Zero Trust plan.*Mutual TLS Certificates/s);
  });

  it("reports Cloudflare's own reason for an ordinary failure", async () => {
    const api = respond(400, { success: false, errors: [{ code: 1004, message: "DNS record already exists" }] });
    await expect(api.request(`/zones/${account}/dns_records`, "POST", {}))
      .rejects.toThrow("DNS record already exists (code 1004)");
  });

  it("does not attach the plan hint to unrelated paths", async () => {
    const api = respond(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    await expect(api.request(`/accounts/${account}/cfd_tunnel`, "POST", {}))
      .rejects.toThrow(/^(?!.*Zero Trust plan).*Authentication error/s);
  });

  it("never reflects the bearer token back into a message", async () => {
    const api = respond(403, { success: false, errors: [{ code: 10000, message: "Bad token secret-token" }] });
    await expect(api.request(`/accounts/${account}/access/certificates`))
      .rejects.toThrow(/^(?!.*secret-token)/s);
  });

  it("falls back to the status when the body is not Cloudflare JSON", async () => {
    const api = new CloudflareApi("secret-token", async () => new Response("<html>502</html>", { status: 502 }));
    await expect(api.request(`/accounts/${account}/access/apps`))
      .rejects.toThrow("Cloudflare API returned HTTP 502. Check token permissions and account access.");
  });
});
