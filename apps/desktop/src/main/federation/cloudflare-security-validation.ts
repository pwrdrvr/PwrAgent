import https from "node:https";
import { randomBytes } from "node:crypto";
import type { CloudflareSecurityCheck } from "@pwragent/shared";
import type { CloudflareCertificate } from "./cloudflare-certificates";
import type { CloudflareOriginProbes } from "./cloudflare-origin-probes";

export type CloudflareProbeResponse = { status: number; proof?: string; ray?: string; cookie?: string };
export type CloudflareProbeRequest = {
  endpoint: string;
  id: string;
  upgrade: boolean;
  credentials?: CloudflareCertificate;
  cookie?: string;
};

export async function requestCloudflareProbe(input: CloudflareProbeRequest): Promise<CloudflareProbeResponse> {
  const url = new URL(input.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Security validation requires a standard HTTPS endpoint.");
  }
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      agent: false, // No TLS session/cookie reuse between positive and negative probes.
      cert: input.credentials?.certificate,
      key: input.credentials?.privateKey,
      headers: {
        "X-PwrAgent-Security-Probe": input.id,
        "Cache-Control": "no-cache, no-store",
        ...(input.cookie ? { Cookie: input.cookie } : {}),
        ...(input.upgrade ? {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        } : {}),
      },
    });
    const deadline = setTimeout(() => request.destroy(new Error("Endpoint probe timed out.")), 15_000);
    const finish = (status: number, headers: Record<string, unknown>) => {
      clearTimeout(deadline);
      resolve({ status,
        proof: typeof headers["x-pwragent-probe-proof"] === "string" ? headers["x-pwragent-probe-proof"] : undefined,
        ray: typeof headers["cf-ray"] === "string" ? headers["cf-ray"] : undefined,
        cookie: Array.isArray(headers["set-cookie"])
          ? headers["set-cookie"].filter((value): value is string => typeof value === "string")
            .map((value) => value.split(";", 1)[0]).join("; ")
          : undefined,
      });
    };
    request.on("response", (response) => {
      finish(response.statusCode ?? 0, response.headers);
      response.destroy(); // Do not read or reflect arbitrary HTML, or follow redirects.
    });
    request.on("upgrade", (response, socket) => {
      finish(response.statusCode ?? 101, response.headers);
      socket.destroy();
    });
    request.on("error", () => {
      clearTimeout(deadline);
      reject(new Error("Endpoint probe failed. Check DNS, TLS, and connector health; this is not a security pass."));
    });
    request.end();
  });
}

export async function validateCloudflareBoundary(options: {
  endpoint: string;
  credentials: CloudflareCertificate;
  probes: CloudflareOriginProbes;
  request?: typeof requestCloudflareProbe;
}): Promise<CloudflareSecurityCheck[]> {
  const request = options.request ?? requestCloudflareProbe;
  const checks: CloudflareSecurityCheck[] = [];
  // The same URL and HTTP/upgrade shapes pass through the same Access/ingress
  // matchers. Only the client certificate and unpredictable correlation ID vary.
  for (const upgrade of [false, true]) {
    const label = upgrade ? "WebSocket upgrade" : "HTTPS request";
    const positive = options.probes.arm();
    const negative = options.probes.arm();
    try {
      const accepted = await request({ endpoint: options.endpoint, id: positive.id, upgrade, credentials: options.credentials });
      const controlPassed = accepted.status === 204 && accepted.proof === positive.proof && positive.observed();
      checks.push({ label: `${label} with certificate`, passed: controlPassed,
        detail: controlPassed ? "Reached this gateway; private response proof matched." : "Could not prove that the credentialed request reached this gateway." });
      const rejected = await request({ endpoint: options.endpoint, id: negative.id, upgrade });
      const passed = controlPassed && rejected.status === 403 && Boolean(rejected.ray)
        && !negative.observed() && !rejected.proof;
      checks.push({ label: `${label} without certificate`, passed,
        detail: negative.observed()
          ? "FAILED: the certificate-free request reached the gateway."
          : passed ? "Cloudflare returned 403; this gateway did not receive the probe."
            : `HTTP ${rejected.status}; edge rejection was not proven.` });
      if (accepted.cookie) {
        const sessionProbe = options.probes.arm();
        try {
          const session = await request({ endpoint: options.endpoint, id: sessionProbe.id, upgrade, cookie: accepted.cookie });
          const sessionPassed = controlPassed && session.status === 403 && Boolean(session.ray)
            && !sessionProbe.observed() && !session.proof;
          checks.push({ label: `${label} with session cookie only`, passed: sessionPassed,
            detail: sessionPassed ? "A previously issued cookie cannot replace the client certificate."
              : "Certificate-free cookie reuse was not rejected at the edge. Do not rely on this endpoint's mTLS gate." });
        } finally { sessionProbe.close(); }
      }
    } finally {
      positive.close();
      negative.close();
    }
  }
  return checks;
}
