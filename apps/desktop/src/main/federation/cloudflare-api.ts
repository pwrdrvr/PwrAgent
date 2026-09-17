// Deliberately fixed API origin. No renderer URL, redirect, or API error body can
// redirect a bearer token or reflect secrets into diagnostics.

/**
 * Cloudflare's own `errors[]` entries, reduced to something safe to show.
 *
 * The body is Cloudflare product text describing what it refused; the bearer
 * token travels in a request header and is never echoed back. Dropping the body
 * entirely — which this client used to do — made an entitlement refusal and a
 * missing token permission read as the same sentence, which is the one
 * distinction an operator actually needs.
 *
 * Still treated as untrusted: length-capped, control characters stripped, and
 * suppressed outright on the remote chance it contains the token.
 */
function describeCloudflareErrors(payload: unknown, token: string): string {
  if (!payload || typeof payload !== "object") return "";
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return "";
  const parts: string[] = [];
  for (const entry of errors.slice(0, 3)) {
    if (!entry || typeof entry !== "object") continue;
    const { code, message } = entry as { code?: unknown; message?: unknown };
    if (typeof message !== "string" || !message) continue;
    const clean = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    if (!clean || clean.includes(token)) continue;
    parts.push(typeof code === "number" ? `${clean} (code ${code})` : clean);
  }
  return parts.join("; ");
}

/**
 * Access mTLS is a Contract/Enterprise Zero Trust entitlement, so the CA upload
 * in `provision` is the first call a non-contract account can fail.
 *
 * Cloudflare does not report that as a plan error. Measured against a
 * non-contract account with an empty Mutual TLS list, it answers
 * `access.api.error.invalid_request: maximum number of certificates has been
 * reached` — the plan's quota is zero, so the first upload is already over it.
 * Passed through unedited that sentence sends an operator hunting for
 * certificates to delete when they have none, so name the likely cause and the
 * one observation that separates it from the real 50-certificate ceiling.
 *
 * A plain authorization failure stays ambiguous between the entitlement and a
 * token scoped without `Access: Mutual TLS Certificates`, so it names both.
 */
function cloudflareFailureHint(status: number, path: string, detail: string): string {
  if (!path.includes("/access/certificates")) return "";
  if (/maximum number of certificates/i.test(detail)) {
    return " On a Zero Trust plan without Access mTLS the quota is zero, so the first"
      + " upload reports this. If Zero Trust → Access controls → Service credentials →"
      + " Mutual TLS lists no certificates, this is the plan, not a full account.";
  }
  if (status !== 403 && status !== 400) return "";
  return " Access mTLS requires a Contract (Enterprise) Zero Trust plan and a token with"
    + " Access: Mutual TLS Certificates → Edit. Confirm the plan before re-scoping the token.";
}

export class CloudflareApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!/^\/(accounts|zones)\/[a-f0-9]{32}(\/|\?|$)/.test(path)) {
      throw new Error("Invalid Cloudflare resource path.");
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Cloudflare API could not be reached. Check your connection and try again.");
    }
    if (!response.ok) {
      // Bounded read: an error body is small, and a hostile one must not be
      // able to grow this message without limit.
      let detail = "";
      try {
        const body = (await response.text()).slice(0, 16 * 1024);
        detail = describeCloudflareErrors(JSON.parse(body), this.token);
      } catch { /* A non-JSON or unreadable body leaves only the status. */ }
      throw new Error(
        `Cloudflare API returned HTTP ${response.status}.${detail ? ` ${detail}.` : ""}`
        + cloudflareFailureHint(response.status, path, detail)
        + (detail ? "" : " Check token permissions and account access."),
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Cloudflare returned an empty response.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 4 * 1024 * 1024) throw new Error("Cloudflare response exceeds the setup limit.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let data: { success?: boolean; result: T };
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Cloudflare returned an invalid response."); }
    if (data.success !== true) {
      // A 200 carrying `success: false` still names its reason in `errors[]`.
      const detail = describeCloudflareErrors(data, this.token);
      throw new Error(
        detail
          ? `Cloudflare did not accept the operation. ${detail}.${cloudflareFailureHint(403, path, detail)}`
          : "Cloudflare did not accept the operation. Check account permissions.",
      );
    }
    return data.result;
  }

  async list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await this.request<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      if (!Array.isArray(entries)) throw new Error("Cloudflare returned an invalid resource list.");
      all.push(...entries);
      if (entries.length < 50) return all;
    }
    throw new Error("Cloudflare resource list is too large to audit completely.");
  }
}

export type AccessApplication = {
  id: string;
  domain?: string;
  type?: string;
  destinations?: Array<{ uri?: string; type?: string }>;
};

export function applicationCoversHostname(app: AccessApplication, hostname: string): boolean {
  const domains = [app.domain, ...(app.destinations ?? []).map((d) => d.uri)];
  return domains.some((domain) => {
    if (!domain) return false;
    const host = domain.toLowerCase().split("/")[0];
    const expression = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`).test(hostname);
  });
}

/**
 * The two credentials Cloudflare Access can admit a non-interactive client with.
 *
 * `service-token` is available on every Zero Trust plan, including Free.
 * `mtls` requires a paid plan and is confirmed unavailable on Free, so it is an
 * option rather than the default. Both ride the same Service Auth decision and
 * the same deny-by-default provisioning order; only the selector differs.
 */
export type CloudflareGate = "service-token" | "mtls";

export function cloudflareAdmissionPolicy(gate: CloudflareGate, ids: string[]) {
  return gate === "mtls" ? cloudflareMtlsPolicy(ids) : cloudflareServiceTokenPolicy(ids);
}

export function cloudflareServiceTokenPolicy(tokenIds: string[]) {
  return {
    name: "PwrAgent service tokens",
    decision: "non_identity",
    include: tokenIds.map((id) => ({ service_token: { token_id: id } })),
    // No `require`: the service-token selector is itself the credential check.
    // An empty array is meaningful here and must survive the exact comparison.
    require: [],
    exclude: [],
  };
}

export function cloudflareMtlsPolicy(commonNames: string[]) {
  return {
    name: "PwrAgent certificate holders",
    decision: "non_identity",
    include: commonNames.map((name) => ({ common_name: { common_name: name } })),
    require: [{ certificate: {} }],
    exclude: [],
  };
}

export function isExactAdmissionPolicy(gate: CloudflareGate, value: unknown, ids: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const expected = cloudflareAdmissionPolicy(gate, ids);
  // A policy carrying no includes admits nobody, but it also cannot be
  // distinguished from one whose selectors were stripped. Refuse either way
  // rather than calling an empty allowlist a passing audit.
  if (ids.length === 0) return false;
  // `require` is compared verbatim in both directions: a certificate
  // requirement appearing on a service-token policy, or disappearing from an
  // mTLS one, both have to fail.
  const requireMatches = JSON.stringify(p.require ?? []) === JSON.stringify(expected.require);
  return p.decision === expected.decision
    && requireMatches
    && Array.isArray(p.include)
    && p.include.length === ids.length
    && p.include.every((rule) => expected.include.some((r) => JSON.stringify(r) === JSON.stringify(rule)))
    && (!p.exclude || (Array.isArray(p.exclude) && p.exclude.length === 0));
}

export function isExactMtlsPolicy(value: unknown, names: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const expected = cloudflareMtlsPolicy(names);
  // Unknown selectors, a second include alternative, or a missing require must
  // never be mistaken for mandatory certificate authentication.
  return p.decision === expected.decision
    && JSON.stringify(p.require) === JSON.stringify(expected.require)
    && Array.isArray(p.include)
    && p.include.length === names.length
    && p.include.every((rule) => expected.include.some((r) => JSON.stringify(r) === JSON.stringify(rule)))
    && (!p.exclude || (Array.isArray(p.exclude) && p.exclude.length === 0));
}

export function cloudflareScopeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new Error("Enter a valid Cloudflare account and zone ID.");
  return value;
}

export function cloudflareHostname(value: string, zone: string): string {
  const host = value.trim().toLowerCase();
  // Universal SSL covers one label below the zone. This also excludes URLs,
  // IP literals, wildcard rules, ports, and deeper names needing paid coverage.
  const prefix = host.slice(0, -(zone.length + 1));
  if (!host.endsWith(`.${zone}`) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
    throw new Error(`Choose a single-level hostname such as federation.${zone}.`);
  }
  return host;
}
