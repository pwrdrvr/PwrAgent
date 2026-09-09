import { describe, expect, it } from "vitest";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createCloudflareCa, issueCloudflareClient } from "../federation/cloudflare-certificates";
import { CloudflareOriginProbes } from "../federation/cloudflare-origin-probes";
import { validateCloudflareBoundary } from "../federation/cloudflare-security-validation";
import { encryptCloudflareBundle, decryptCloudflareBundle } from "../federation/cloudflare-client-bundle";
import { applicationCoversHostname, cloudflareMtlsPolicy, isExactMtlsPolicy, cloudflareHostname, CloudflareApi } from "../federation/cloudflare-api";

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

  it("cannot arm probes from public input and bounds local probe allocations", () => {
    const probes = new CloudflareOriginProbes();
    expect(probes.observe({ headers: { "x-pwragent-security-probe": "attacker" } } as unknown as IncomingMessage)).toBeUndefined();
    for (let i = 0; i < 16; i++) probes.arm();
    expect(() => probes.arm()).toThrow("already running");
  });
});

describe("Cloudflare policy audit", () => {
  it("requires both a valid certificate and the exact client allowlist", () => {
    const policy = cloudflareMtlsPolicy(["client-a"]);
    expect(isExactMtlsPolicy(policy, ["client-a"])).toBe(true);
    expect(isExactMtlsPolicy({ ...policy, decision: "bypass" }, ["client-a"])).toBe(false);
    expect(isExactMtlsPolicy({ ...policy, require: [] }, ["client-a"])).toBe(false);
    expect(isExactMtlsPolicy({ ...policy, include: [...policy.include, { everyone: {} }] }, ["client-a"])).toBe(false);
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
