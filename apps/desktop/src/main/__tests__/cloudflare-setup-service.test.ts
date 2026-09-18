import { describe, expect, it, vi } from "vitest";
import { CloudflareSetupService, type CloudflareSetupState } from "../federation/cloudflare-setup-service";
import { CloudflareApi } from "../federation/cloudflare-api";
import { CloudflareOriginProbes } from "../federation/cloudflare-origin-probes";

type Gate = "service-token" | "oauth" | "mtls";

function harness(gate: Gate = "service-token", emails: string[] = ["Operator@Example.com"]) {
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
      result = { id, ...body, ...(path.endsWith("/certificates") ? { expires_on: "2036-01-01" } : {}), ...(path.endsWith("/cfd_tunnel") ? { token: "connector-secret" } : {}),
        // Cloudflare returns the secret exactly once, on create.
        ...(path.endsWith("/service_tokens") ? { client_id: `${id}.access`, client_secret: `secret-${id}`, expires_at: "2036-01-01T00:00:00Z" } : {}) };
      resources.set(`${path}/${id}`, result as Record<string, unknown>);
    } else if (method === "DELETE") {
      resources.delete(path);
      result = { id: path.split("/").at(-1) };
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
  return { service, calls, resources, publishUrl, startConnector, verifyListener, gate,
    tamper: () => { tamper = true; }, state: () => stored,
    connect: () => service.connect("x".repeat(40), "a".repeat(32), "b".repeat(32), gate),
    provision: () => service.provision("federation.example.com", 47830, gate, gate === "oauth" ? emails : undefined),
  };
}

// Both gates ride the same provisioning order, audit, and revocation flow, so
// every one of these runs twice. The credential is the only thing that differs.
// `oauth` has its own block below: it issues no per-client credential, so the
// issue-and-revoke half of this suite does not apply to it.
describe.each<Gate>(["service-token", "mtls"])("Cloudflare provisioning (%s)", (gate) => {
  // Under mTLS the certificate authority is uploaded first; a service-token
  // endpoint has no CA to upload and mints its validator token before this.
  const creates = gate === "mtls"
    ? ["certificates", "apps", "policies", "cfd_tunnel", "dns_records"]
    : ["service_tokens", "apps", "policies", "cfd_tunnel", "dns_records"];

  it("creates and audits admission before DNS publication, keeps secrets out of later API calls", async () => {
    const h = harness(gate);
    await h.connect();
    await h.provision();
    const mutations = h.calls.filter((call) => call.method === "POST");
    expect(mutations.map((call) => call.path.split("/").at(-1))).toEqual(creates);
    expect(JSON.stringify(h.calls)).not.toContain("PRIVATE KEY");
    expect(h.startConnector).toHaveBeenCalledWith("connector-secret");
    expect(h.publishUrl).toHaveBeenCalledWith("wss://federation.example.com");
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    const status = await h.service.status();
    expect(status.gate).toBe(gate);
    expect(JSON.stringify(status)).not.toContain("connector-secret");
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    // The validator's own secret must not reach the status projection either.
    const verifierSecret = h.state()?.verifier.clientSecret;
    if (verifierSecret) expect(JSON.stringify(status)).not.toContain(verifierSecret);
    await h.provision();
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(creates.length);
  });

  it("does not publish DNS when read-back finds a bypass policy", async () => {
    const h = harness(gate);
    await h.connect();
    h.tamper();
    await expect(h.provision()).rejects.toThrow("audit failed");
    expect(h.calls.some((call) => call.method === "POST" && call.path.endsWith("dns_records"))).toBe(false);
    expect(h.startConnector).not.toHaveBeenCalled();
    expect(h.state()?.applicationId).toBeDefined();
  });

  it("refuses a competing wildcard Access application without changing it", async () => {
    const h = harness(gate);
    h.resources.set(`/accounts/${"a".repeat(32)}/access/apps/existing`, { id: "existing", domain: "*.example.com" });
    await h.connect();
    await expect(h.provision()).rejects.toThrow("already covers");
    // The validator credential is minted before the conflict check, so a
    // service-token run has exactly one create to its name and no more.
    const mutations = h.calls.filter((call) => call.method !== "GET");
    expect(mutations.map((call) => call.path.split("/").at(-1)))
      .toEqual(gate === "mtls" ? [] : ["service_tokens"]);
  });

  it("does not mutate Cloudflare without local listener ownership", async () => {
    const h = harness(gate);
    await h.connect();
    h.verifyListener.mockImplementation(() => { throw new Error("wrong listener"); });
    await expect(h.provision()).rejects.toThrow("wrong listener");
    expect(h.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("admits and revokes each issued client without exposing its secret", async () => {
    const h = harness(gate);
    await h.connect();
    await h.provision();
    const client = await h.service.issue("Travel laptop");
    expect(h.state()?.clients[0].id).toBe(client.id);
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    const secret = client.privateKey ?? client.clientSecret;
    expect(secret).toBeTruthy();
    // The credential's private half is created here and must never be sent to
    // Cloudflare afterwards, nor surface in the renderer-facing projection.
    const callsAfterIssue = JSON.stringify(h.calls.filter((call) => call.method !== "POST" || !call.path.endsWith("/service_tokens")));
    expect(callsAfterIssue).not.toContain(secret);
    expect(JSON.stringify(await h.service.status())).not.toContain(secret);
    await h.service.revoke(client.id);
    expect(h.state()?.clients[0].revoked).toBe(true);
    const policyUpdate = h.calls.filter((call) => call.method === "PUT" && call.path.includes("/policies/")).at(-1);
    expect(JSON.stringify(policyUpdate?.body)).not.toContain(client.id);
    expect(JSON.stringify(policyUpdate?.body)).toContain(h.state()?.verifier.id);
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
  });

  it("refuses to change gate on an existing endpoint", async () => {
    const h = harness(gate);
    await h.connect();
    await h.provision();
    const other: Gate = gate === "mtls" ? "service-token" : "mtls";
    await expect(h.service.provision("federation.example.com", 47830, other))
      .rejects.toThrow("different admission gate");
  });
});

describe("Cloudflare connection permission checks", () => {
  it.each<[Gate, string]>([["service-token", "service_tokens"], ["oauth", "service_tokens"], ["mtls", "certificates"]])(
    "checks only the credential permission the %s gate uses",
    async (gate, expected) => {
      const h = harness(gate);
      await h.connect();
      const credentialReads = h.calls.filter((call) => /\/access\/(certificates|service_tokens)/.test(call.path));
      expect(credentialReads.map((call) => call.path.split("/").at(-1))).toEqual([expected]);
    },
  );
});

describe("Cloudflare service-token admission", () => {
  it("deletes the Cloudflare token on revoke, because it outlives the policy edit", async () => {
    const h = harness("service-token");
    await h.connect();
    await h.provision();
    const client = await h.service.issue("Travel laptop");
    await h.service.revoke(client.id);
    const deletes = h.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path.split("/").at(-1))).toEqual([client.id]);
    // The secret is unrecoverable and the token is gone; keeping the copy would
    // be a credential we can neither use nor rotate.
    expect(h.state()?.clients[0].clientSecret).toBeUndefined();
  });

  it("fails the audit when the policy admits a token that no longer exists", async () => {
    const h = harness("service-token");
    await h.connect();
    await h.provision();
    const client = await h.service.issue("Travel laptop");
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    // Deleted in Cloudflare behind our back, leaving the policy naming a
    // credential nothing can present.
    h.resources.delete(`/accounts/${"a".repeat(32)}/access/service_tokens/${client.id}`);
    const checks = await h.service.audit();
    const tokens = checks.find((check) => check.label === "Issued service tokens");
    expect(tokens?.passed).toBe(false);
    expect(checks.find((check) => check.label === "Mandatory service token")?.passed).toBe(true);
  });

  it("never uploads a certificate authority", async () => {
    const h = harness("service-token");
    await h.connect();
    await h.provision();
    expect(h.calls.some((call) => call.path.includes("/access/certificates") && call.method !== "GET")).toBe(false);
    expect(h.state()?.ca).toBeUndefined();
    expect(h.state()?.certificateId).toBeUndefined();
  });
});

describe("Cloudflare sign-in (oauth) admission", () => {
  const account = `/accounts/${"a".repeat(32)}`;
  const app = (h: ReturnType<typeof harness>) => `${account}/access/apps/${h.state()?.applicationId}`;

  it("enables Managed OAuth and both policies before DNS publication", async () => {
    const h = harness("oauth");
    await h.connect();
    await h.provision();
    const mutations = h.calls.filter((call) => call.method === "POST");
    // Validator token, then a deny-all application, then both policies — all
    // before the tunnel and long before the hostname resolves.
    expect(mutations.map((call) => call.path.split("/").at(-1)))
      .toEqual(["service_tokens", "apps", "policies", "policies", "cfd_tunnel", "dns_records"]);
    const created = mutations.find((call) => call.path.endsWith("/apps"))!.body;
    expect(created.policies).toEqual([]);
    expect(created.oauth_configuration).toMatchObject({
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_loopback: true, allowed_uris: [] },
    });
    const [identity, service] = mutations.filter((call) => call.path.endsWith("/policies")).map((call) => call.body);
    expect(identity).toMatchObject({ decision: "allow", include: [{ email: { email: "operator@example.com" } }], require: [] });
    // The Service Auth policy admits the validator alone; people sign in.
    expect(service).toMatchObject({ decision: "non_identity", include: [{ service_token: { token_id: h.state()?.verifier.id } }] });
    const checks = await h.service.audit();
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checks.map((check) => check.label)).toEqual(expect.arrayContaining(["Managed OAuth sign-in", "Allowed people", "Validator service token"]));
    expect((await h.service.status()).emails).toEqual(["operator@example.com"]);
    expect((await h.service.status()).gate).toBe("oauth");
  });

  it("rejects an unusable allowlist before touching Cloudflare", async () => {
    for (const emails of [[], ["not an email"], ["a@b"]]) {
      const h = harness("oauth", emails);
      await h.connect();
      await expect(h.provision()).rejects.toThrow(/email/);
      expect(h.calls.some((call) => call.method !== "GET")).toBe(false);
      expect(h.state()).toBeUndefined();
    }
  });

  it("fails the audit when Managed OAuth is off or allows a third-party redirect", async () => {
    for (const oauth of [
      { ...{ enabled: false }, dynamic_client_registration: { enabled: true, allow_any_on_loopback: true } },
      { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_loopback: true, allowed_uris: ["https://collector.example.net/*"] } },
      { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_loopback: false } },
    ]) {
      const h = harness("oauth");
      await h.connect();
      await h.provision();
      h.resources.set(app(h), { ...h.resources.get(app(h)), oauth_configuration: oauth });
      const checks = await h.service.audit();
      expect(checks.find((check) => check.label === "Managed OAuth sign-in")?.passed).toBe(false);
    }
  });

  it("fails the audit when any other way in appears beside the two policies", async () => {
    const h = harness("oauth");
    await h.connect();
    await h.provision();
    h.resources.set(`${app(h)}/policies/extra`, { id: "extra", decision: "bypass", include: [{ everyone: {} }] });
    const checks = await h.service.audit();
    expect(checks.find((check) => check.label === "Allowed people")?.passed).toBe(false);
    expect(checks.find((check) => check.label === "Validator service token")?.passed).toBe(false);
  });

  it("replaces the allowlist in Cloudflare first, then locally", async () => {
    const h = harness("oauth");
    await h.connect();
    await h.provision();
    await h.service.setEmails(["second@example.com", "SECOND@example.com", "third@example.com"]);
    const update = h.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/policies/${h.state()?.identityPolicyId}`)).at(-1);
    expect(update?.body.include).toEqual([{ email: { email: "second@example.com" } }, { email: { email: "third@example.com" } }]);
    expect(h.state()?.emails).toEqual(["second@example.com", "third@example.com"]);
    expect((await h.service.audit()).every((check) => check.passed)).toBe(true);
    await expect(h.service.setEmails([])).rejects.toThrow("at least one email");
    expect(h.state()?.emails).toEqual(["second@example.com", "third@example.com"]);
  });

  it("shares setups without minting a credential per client", async () => {
    const h = harness("oauth");
    await h.connect();
    await h.provision();
    await expect(h.service.issue("Travel laptop")).rejects.toThrow("sign in as themselves");
    const tokensBefore = h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/service_tokens")).length;
    await expect(h.service.assertShareable()).resolves.toMatchObject({ gate: "oauth" });
    expect(h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/service_tokens"))).toHaveLength(tokensBefore);
  });

  it("keeps the allowlist out of the other gates", async () => {
    const h = harness("service-token");
    await h.connect();
    await h.provision();
    await expect(h.service.setEmails(["a@example.com"])).rejects.toThrow("Only a sign-in endpoint");
    expect(h.calls.some((call) => call.body && JSON.stringify(call.body).includes("oauth_configuration"))).toBe(false);
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

  it("explains a quota-zero refusal rather than passing on \"maximum reached\"", async () => {
    // Measured against a non-contract account with an empty Mutual TLS list.
    // Verbatim, this message sends an operator looking for certificates to
    // delete when they have none.
    const api = respond(400, {
      success: false,
      errors: [{ code: 12130, message: "access.api.error.invalid_request: maximum number of certificates has been reached" }],
    });
    const failure = await api.request(`/accounts/${account}/access/certificates`, "POST", {})
      .then(() => undefined, (error: Error) => error.message);
    expect(failure).toContain("maximum number of certificates has been reached");
    expect(failure).toContain("quota is zero");
    expect(failure).toContain("lists no certificates");
    // The generic plan/token sentence would contradict the specific one.
    expect(failure).not.toContain("Confirm the plan before re-scoping");
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
