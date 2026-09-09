// Deliberately fixed API origin. No renderer URL, redirect, or API error body can
// redirect a bearer token or reflect secrets into diagnostics.
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
      await response.body?.cancel();
      throw new Error(`Cloudflare API returned HTTP ${response.status}. Check token permissions and account access.`);
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
    if (data.success !== true) throw new Error("Cloudflare did not accept the operation. Check account permissions.");
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

export function cloudflareMtlsPolicy(commonNames: string[]) {
  return {
    name: "PwrAgent certificate holders",
    decision: "non_identity",
    include: commonNames.map((name) => ({ common_name: { common_name: name } })),
    require: [{ certificate: {} }],
    exclude: [],
  };
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
