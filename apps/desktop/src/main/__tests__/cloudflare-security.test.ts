import { describe, expect, it } from "vitest";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createCloudflareCa, issueCloudflareClient } from "../federation/cloudflare-certificates";
import { CloudflareOriginProbes } from "../federation/cloudflare-origin-probes";
import { refusedAtEdge, validateCloudflareBoundary } from "../federation/cloudflare-security-validation";
import { encryptCloudflareBundle, decryptCloudflareBundle } from "../federation/cloudflare-client-bundle";
import { applicationCoversHostname, cloudflareMtlsPolicy, isExactAdmissionPolicy, cloudflareHostname, CloudflareApi } from "../federation/cloudflare-api";

describe("Cloudflare client certificates", () => {
  it("issues a client-auth certificate under a local CA and protects its transfer bundle", async () => {
    const ca = await createCloudflareCa();
    const client = await issueCloudflareClient(ca, `pwragent-${"a".repeat(32)}`);
    const root = new X509Certificate(ca.certificate);
    const leaf = new X509Certificate(client.certificate);
    expect(root.ca).toBe(true);
    expect(root.verify(root.publicKey)).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(leaf.checkPrivateKey(createPrivateKey(client.privateKey))).toBe(true);
    const bundle = { version: 1 as const, endpoint: "wss://federation.example.com", invite: "test-invite", ...client };
    const encrypted = await encryptCloudflareBundle(bundle, "a-long-test-password");
    expect(encrypted).not.toContain("PRIVATE KEY");
    expect(await decryptCloudflareBundle(encrypted, "a-long-test-password")).toEqual(bundle);
    await expect(decryptCloudflareBundle(encrypted, "wrong-password")).rejects.toThrow("Could not open");
    const tampered = JSON.parse(encrypted);
    tampered.tag = Buffer.alloc(16).toString("base64");
    await expect(decryptCloudflareBundle(JSON.stringify(tampered), "a-long-test-password")).rejects.toThrow();
  });
});

describe("Cloudflare admission proof", () => {
  const credentials = { certificate: "cert", privateKey: "key" };
  it("requires positive gateway proof and absent negative probes for HTTP and WebSocket", async () => {
    const probes = new CloudflareOriginProbes();
    const shapes: boolean[] = [];
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials,
      request: async (input) => {
        shapes.push(input.upgrade);
        if (!input.credentials) return { status: 403, ray: "edge-ray" };
        return { status: 204, proof: probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage) };
      },
    });
    expect(shapes).toEqual([false, false, true, true]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("fails if an origin returned the 403 even with Cloudflare headers", async () => {
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials,
      request: async (input) => {
        const proof = probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage);
        return input.credentials ? { status: 204, proof } : { status: 403, ray: "edge-ray" };
      },
    });
    expect(checks.filter((check) => !check.passed)).toHaveLength(2);
    expect(checks[1].detail).toContain("reached the gateway");
  });

  it("does not pass a dead or wrong gateway merely because every request returns 403", async () => {
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes: new CloudflareOriginProbes(), credentials,
      request: async () => ({ status: 403, ray: "edge-ray" }),
    });
    expect(checks.every((check) => !check.passed)).toBe(true);
  });

  it("detects a previously issued cookie bypassing certificate admission", async () => {
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials,
      request: async (input) => {
        if (!input.credentials && !input.cookie) return { status: 403, ray: "edge" };
        const proof = probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage);
        return { status: 204, proof, cookie: "CF_Authorization=secret" };
      },
    });
    expect(checks.filter((check) => check.label.includes("cookie only"))).toHaveLength(2);
    expect(checks.filter((check) => check.label.includes("cookie only")).every((check) => !check.passed)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("CF_Authorization=secret");
  });

  it("does not replay the cookie on a sign-in endpoint, where Access admits it by design", async () => {
    // An identity application honors its own session cookie in place of a
    // sign-in; the audit bounds that with the session duration instead.
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials, gate: "oauth",
      request: async (input) => {
        if (!input.credentials && !input.cookie) return { status: 401, ray: "edge" };
        const proof = probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage);
        return { status: 204, proof, cookie: "CF_Authorization=secret" };
      },
    });
    expect(checks.some((check) => check.label.includes("cookie"))).toBe(false);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("cannot arm probes from public input and bounds local probe allocations", () => {
    const probes = new CloudflareOriginProbes();
    expect(probes.observe({ headers: { "x-pwragent-security-probe": "attacker" } } as unknown as IncomingMessage)).toBeUndefined();
    for (let i = 0; i < 16; i++) probes.arm();
    expect(() => probes.arm()).toThrow("already running");
  });
});

describe("Cloudflare policy audit", () => {
  it("requires both a valid certificate and the exact client allowlist", () => {
    // The comparison the audit ships with, not a copy of it.
    const policy = cloudflareMtlsPolicy(["client-a"]);
    expect(isExactAdmissionPolicy("mtls", policy, ["client-a"])).toBe(true);
    expect(isExactAdmissionPolicy("mtls", { ...policy, decision: "bypass" }, ["client-a"])).toBe(false);
    expect(isExactAdmissionPolicy("mtls", { ...policy, require: [] }, ["client-a"])).toBe(false);
    expect(isExactAdmissionPolicy("mtls", { ...policy, include: [...policy.include, { everyone: {} }] }, ["client-a"])).toBe(false);
    // An empty allowlist admits nobody, and must not pass as an exact match either.
    expect(isExactAdmissionPolicy("mtls", cloudflareMtlsPolicy([]), [])).toBe(false);
  });
  it("detects wildcard and path-specific applications that can override the endpoint", () => {
    for (const domain of ["*.example.com", "federation.example.com/private", "federation.example.com"]) {
      expect(applicationCoversHostname({ id: "app", domain }, "federation.example.com")).toBe(true);
    }
    expect(applicationCoversHostname({ id: "app", domain: "other.example.com" }, "federation.example.com")).toBe(false);
    expect(() => cloudflareHostname("federation.home.example.com", "example.com")).toThrow();
    expect(() => cloudflareHostname("example.com.evil.test", "example.com")).toThrow();
  });
  it("does not expose API bodies and never follows redirects with its bearer token", async () => {
    let init: RequestInit | undefined;
    const api = new CloudflareApi("secret-token", async (_url, options) => {
      init = options;
      return new Response("secret-token reflected here", { status: 403 });
    });
    await expect(api.request(`/accounts/${"a".repeat(32)}/access/apps`)).rejects.toThrow("HTTP 403");
    expect(init?.redirect).toBe("error");
    await expect(api.request("https://evil.example")).rejects.toThrow("Invalid Cloudflare");
  });
});

describe("Cloudflare service-token admission proof", () => {
  const credentials = { accessClientId: "abc.access", accessClientSecret: "a-service-token-secret" };

  it("proves the same boundary with a service token and names it in every result", async () => {
    const probes = new CloudflareOriginProbes();
    const shapes: boolean[] = [];
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials,
      request: async (input) => {
        shapes.push(input.upgrade);
        if (!input.credentials) return { status: 403, ray: "edge-ray" };
        return { status: 204, proof: probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage) };
      },
    });
    expect(shapes).toEqual([false, false, true, true]);
    expect(checks.every((check) => check.passed)).toBe(true);
    // A result reading "without certificate" here would describe a test that
    // never ran — nothing in this flow presents a certificate.
    expect(checks.map((check) => check.label)).toEqual([
      "HTTPS request with service token",
      "HTTPS request without service token",
      "WebSocket upgrade with service token",
      "WebSocket upgrade without service token",
    ]);
  });

  it("fails when the uncredentialed request reaches the gateway", async () => {
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials,
      request: async (input) => {
        const proof = probes.observe({ headers: { "x-pwragent-security-probe": input.id } } as unknown as IncomingMessage);
        return input.credentials ? { status: 204, proof } : { status: 403, ray: "edge-ray" };
      },
    });
    expect(checks.filter((check) => !check.passed)).toHaveLength(2);
    expect(checks[1].detail).toContain("without a service token reached the gateway");
  });

  it("carries a service token through the encrypted bundle and rejects a mixed one", async () => {
    const bundle = {
      version: 1 as const, gate: "service-token" as const,
      endpoint: "wss://federation.example.com", invite: "test-invite", ...credentials,
    };
    const encrypted = await encryptCloudflareBundle(bundle, "a-long-test-password");
    expect(encrypted).not.toContain("a-service-token-secret");
    expect(await decryptCloudflareBundle(encrypted, "a-long-test-password")).toEqual(bundle);
    // A bundle claiming one gate while carrying the other credential is
    // malformed, and accepting it would install a credential the endpoint's
    // policy does not admit.
    const mixed = await encryptCloudflareBundle(
      { ...bundle, certificate: "cert", privateKey: "key" }, "a-long-test-password");
    await expect(decryptCloudflareBundle(mixed, "a-long-test-password")).rejects.toThrow("Could not open");
    const empty = await encryptCloudflareBundle(
      { version: 1, gate: "service-token", endpoint: bundle.endpoint, invite: "test-invite" }, "a-long-test-password");
    await expect(decryptCloudflareBundle(empty, "a-long-test-password")).rejects.toThrow("Could not open");
  });
});

describe("Cloudflare sign-in (oauth) admission proof", () => {
  // The positive control is still the validator's service token; what a
  // stranger lacks under this gate is a sign-in.
  const credentials = { accessClientId: "abc.access", accessClientSecret: "a-service-token-secret" };
  const observe = (probes: CloudflareOriginProbes, id: string) =>
    probes.observe({ headers: { "x-pwragent-security-probe": id } } as unknown as IncomingMessage);

  it("accepts Managed OAuth's 401 as an edge refusal and labels what is missing", async () => {
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials, gate: "oauth",
      request: async (input) => input.credentials
        ? { status: 204, proof: observe(probes, input.id) }
        : { status: 401, ray: "edge-ray" },
    });
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checks.map((check) => check.label)).toEqual([
      "HTTPS request with service token",
      "HTTPS request without sign-in",
      "WebSocket upgrade with service token",
      "WebSocket upgrade without sign-in",
    ]);
    expect(checks[1].detail).toContain("Cloudflare returned 401");
  });

  it("still fails when an uncredentialed request reaches the gateway, whatever the status", async () => {
    const probes = new CloudflareOriginProbes();
    const checks = await validateCloudflareBoundary({ endpoint: "https://federation.example.com/", probes, credentials, gate: "oauth",
      request: async (input) => {
        const proof = observe(probes, input.id);
        return input.credentials ? { status: 204, proof } : { status: 401, ray: "edge-ray" };
      },
    });
    expect(checks.filter((check) => !check.passed)).toHaveLength(2);
    expect(checks[1].detail).toContain("without a sign-in reached the gateway");
  });

  it("recognizes only Cloudflare's own refusals", () => {
    const edge = { ray: "edge-ray" };
    // Service Auth gates keep their exact 403.
    expect(refusedAtEdge({ ...edge, status: 403 }, "service-token")).toBe(true);
    expect(refusedAtEdge({ ...edge, status: 401 }, "service-token")).toBe(false);
    expect(refusedAtEdge({ ...edge, status: 401 }, "mtls")).toBe(false);
    // A sign-in gate refuses with 401, or sends a browser to its login page.
    expect(refusedAtEdge({ ...edge, status: 401 }, "oauth")).toBe(true);
    expect(refusedAtEdge({ ...edge, status: 302, location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" }, "oauth")).toBe(true);
    expect(refusedAtEdge({ ...edge, status: 302, location: "https://federation.example.com/elsewhere" }, "oauth")).toBe(false);
    expect(refusedAtEdge({ ...edge, status: 302, location: "https://cloudflareaccess.com.example.net/" }, "oauth")).toBe(false);
    expect(refusedAtEdge({ ...edge, status: 200 }, "oauth")).toBe(false);
    // No cf-ray, or the gateway's private proof, means Cloudflare did not answer.
    expect(refusedAtEdge({ status: 401 }, "oauth")).toBe(false);
    expect(refusedAtEdge({ ...edge, status: 401, proof: "p" }, "oauth")).toBe(false);
  });

  it("carries no credential in a sign-in bundle and rejects one that does", async () => {
    const bundle = { version: 1 as const, gate: "oauth" as const, endpoint: "wss://federation.example.com", invite: "test-invite" };
    const encrypted = await encryptCloudflareBundle(bundle, "a-long-test-password");
    expect(await decryptCloudflareBundle(encrypted, "a-long-test-password")).toEqual(bundle);
    const smuggled = await encryptCloudflareBundle({ ...bundle, ...credentials }, "a-long-test-password");
    await expect(decryptCloudflareBundle(smuggled, "a-long-test-password")).rejects.toThrow("Could not open");
  });
});
