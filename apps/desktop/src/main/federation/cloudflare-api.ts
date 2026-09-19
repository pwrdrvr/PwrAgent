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
    const clean = message.replace(/\p{Cc}/gu, " ").trim().slice(0, 200);
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

/** A non-2xx answer from the API, kept with its status so a caller can tell "gone" from "refused". */
export class CloudflareApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
      throw new CloudflareApiError(
        `Cloudflare API returned HTTP ${response.status}.${detail ? ` ${detail}.` : ""}`
        + cloudflareFailureHint(response.status, path, detail)
        + (detail ? "" : " Check token permissions and account access."),
        response.status,
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
  self_hosted_domains?: string[];
  oauth_configuration?: unknown;
  /** How long Access honors its own session cookie for this application; Cloudflare's default is 24h. */
  session_duration?: string;
};

export function applicationCoversHostname(app: AccessApplication, hostname: string): boolean {
  const domains = [app.domain, ...(app.destinations ?? []).map((d) => d.uri), ...(app.self_hosted_domains ?? [])];
  return domains.some((domain) => {
    if (!domain) return false;
    const host = domain.toLowerCase().split("/")[0];
    const expression = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`).test(hostname);
  });
}

/**
 * The app covers exactly one hostname and nothing else.
 *
 * Cloudflare mirrors `domain` into `destinations` and `self_hosted_domains` on
 * every self-hosted app, so their presence is normal: requiring them to be
 * absent failed every app this setup created. A second entry, a path, or a
 * non-public destination is another way in that this setup did not make.
 */
export function isDedicatedApplication(app: AccessApplication, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const destinations = app.destinations ?? [];
  const domains = app.self_hosted_domains ?? [];
  return app.type === "self_hosted"
    && app.domain?.toLowerCase() === host
    && destinations.length <= 1
    && destinations.every((entry) => entry.type === "public" && entry.uri?.toLowerCase() === host)
    && domains.length <= 1
    && domains.every((domain) => domain.toLowerCase() === host);
}

/**
 * How Cloudflare Access admits this endpoint's clients.
 *
 * `service-token` is available on every Zero Trust plan, including Free.
 * `mtls` requires a paid plan and is confirmed unavailable on Free, so it is an
 * option rather than the default. Both ride a Service Auth decision; only the
 * selector differs.
 *
 * `oauth` admits people, not credentials: each one signs in through the
 * organization's login methods and PwrAgent holds a refreshable OAuth grant.
 * Its Service Auth policy admits only the endpoint validator's token, so the
 * positive-control probe keeps working without a human in the loop.
 *
 * All three share the same deny-by-default provisioning order.
 */
export type CloudflareGate = "service-token" | "oauth" | "mtls";

/**
 * The Service Auth policy for a gate. Under `oauth` that is the validator's
 * token alone; the people it admits live in `cloudflareIdentityPolicy`.
 */
export function cloudflareAdmissionPolicy(gate: CloudflareGate, ids: string[]) {
  return gate === "mtls" ? cloudflareMtlsPolicy(ids) : cloudflareServiceTokenPolicy(ids);
}

/**
 * Managed OAuth turns Access into an OAuth 2.0 server for the application, so
 * a non-browser client gets a 401 with discovery metadata instead of a login
 * redirect it cannot follow.
 *
 * Dynamic registration is limited to loopback redirects: PwrAgent receives the
 * authorization code on 127.0.0.1, and no https redirect is allowed that a
 * third-party site could use to collect a grant. The 15-minute access token and
 * two-week grant are Cloudflare's recommendation for CLI and agent clients —
 * a person signs in again only after two weeks without PwrAgent refreshing.
 */
export const CLOUDFLARE_OAUTH_CONFIGURATION = {
  enabled: true,
  dynamic_client_registration: {
    enabled: true,
    allow_any_on_loopback: true,
    allow_any_on_localhost: false,
    allowed_uris: [] as string[],
  },
  grant: {
    access_token_lifetime: "15m",
    session_duration: "336h",
  },
};

/**
 * How long a sign-in endpoint's browser session lasts.
 *
 * On an application with an identity policy, Access accepts its own session
 * cookie in place of a sign-in until the application's session duration ends —
 * 24 hours by default. Matching the access-token lifetime means a person
 * removed from the allowlist loses a browser session when their sign-in lapses.
 * Managed OAuth's token lifetimes are set separately, in `grant`.
 */
export const CLOUDFLARE_SIGN_IN_SESSION_DURATION = "15m";
export const CLOUDFLARE_SIGN_IN_SESSION_LIMIT_MS = 15 * 60_000;

/** A Go duration string, as Cloudflare reports `session_duration` ("15m", "1h30m", "300ms"), in milliseconds. */
export function parseCloudflareDuration(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value)) return undefined;
  const unit: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const [, amount, name] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(amount) * unit[name];
  return total;
}

/**
 * Whether an application's live Managed OAuth settings still let PwrAgent sign
 * in and still refuse third-party redirects.
 *
 * Token lifetimes are not compared: they are the operator's to tune in the
 * dashboard and change nothing about who can get in. An added https redirect
 * does, so any `allowed_uris` entry fails the audit.
 */
export function isExpectedOAuthConfiguration(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const config = value as { enabled?: unknown; dynamic_client_registration?: unknown };
  const registration = config.dynamic_client_registration as
    | { enabled?: unknown; allow_any_on_loopback?: unknown; allowed_uris?: unknown }
    | undefined;
  return config.enabled === true
    && registration?.enabled === true
    && registration.allow_any_on_loopback === true
    && (registration.allowed_uris === undefined
      || (Array.isArray(registration.allowed_uris) && registration.allowed_uris.length === 0));
}

/** The people an `oauth` endpoint admits, by the email their login method verified. */
export function cloudflareIdentityPolicy(emails: string[]) {
  return {
    name: "PwrAgent signed-in people",
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
    require: [],
    exclude: [],
  };
}

export function isExactIdentityPolicy(value: unknown, emails: string[]): boolean {
  return emails.length > 0 && isExactPolicy(value, cloudflareIdentityPolicy(emails));
}

const EMAIL = /^[^\s@<>"',;]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalizes the allowlist an operator typed: trimmed, lowercased, de-duplicated.
 * Cloudflare compares emails case-insensitively, and storing one spelling keeps
 * the policy audit an exact comparison.
 */
export function cloudflareEmails(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Enter at least one email address that may sign in.");
  const emails = [...new Set(value.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : ""))]
    .filter(Boolean);
  if (emails.length === 0) throw new Error("Enter at least one email address that may sign in.");
  if (emails.length > 50) throw new Error("A sign-in policy supports up to 50 email addresses.");
  const invalid = emails.find((email) => email.length > 254 || !EMAIL.test(email));
  if (invalid) throw new Error(`“${invalid.slice(0, 80)}” is not an email address.`);
  return emails;
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
  // A policy carrying no includes admits nobody, but it also cannot be
  // distinguished from one whose selectors were stripped. Refuse either way
  // rather than calling an empty allowlist a passing audit.
  if (ids.length === 0) return false;
  return isExactPolicy(value, cloudflareAdmissionPolicy(gate, ids));
}

function isExactPolicy(
  value: unknown,
  expected: { decision: string; include: unknown[]; require: unknown[] },
): boolean {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  // `require` is compared verbatim in both directions: a certificate
  // requirement appearing on a service-token policy, or disappearing from an
  // mTLS one, both have to fail.
  const requireMatches = JSON.stringify(p.require ?? []) === JSON.stringify(expected.require);
  return p.decision === expected.decision
    && requireMatches
    && Array.isArray(p.include)
    && p.include.length === expected.include.length
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
