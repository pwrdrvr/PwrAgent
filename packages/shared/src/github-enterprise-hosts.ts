const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
export const CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS = 16;
export const GITHUB_ENTERPRISE_HOSTS_CONFLICT =
  "GitHub Enterprise hosts changed while you were editing. Reload the current list before saving.";

/** Canonical spelling for an exact CI-run host match. */
export function normalizeGithubEnterpriseHost(value: unknown): string | undefined {
  const host = typeof value === "string" ? value.trim().toLowerCase().replace(/:443$/, "") : "";
  return HOST.test(host) && host !== "github.com" && host !== "gitlab.com" ? host : undefined;
}

export function validateGithubEnterpriseHosts(
  entries: readonly unknown[],
  url: { parse(value: string): { host: string } | null },
): {
  hosts: string[];
  error?: string;
} {
  const hosts = new Set<string>();
  const invalid: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string" && !entry.trim()) continue;
    const host = normalizeGithubEnterpriseHost(entry);
    // A host must be usable verbatim as the host of an HTTPS run URL.
    if (host && url.parse(`https://${host}`)?.host === host) hosts.add(host);
    else invalid.push(describeInvalidEntry(index + 1, entry));
  }
  if (invalid.length) {
    // The editor shows no line numbers, so quote the entry and say what is wrong.
    const more = invalid.length > 3 ? ` ${invalid.length - 3} more ${invalid.length === 4 ? "entry is" : "entries are"} invalid.` : "";
    return { hosts: [...hosts], error: `${invalid.slice(0, 3).join(" ")}${more} Enter exact hostnames with an optional port.` };
  }
  if (hosts.size > CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS) {
    return { hosts: [...hosts], error: `Enter up to ${CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS} distinct hosts.` };
  }
  return { hosts: [...hosts] };
}

function describeInvalidEntry(line: number, entry: unknown): string {
  if (typeof entry !== "string") return `Line ${line} is not text.`;
  const text = entry.trim();
  const lower = text.toLowerCase();
  const problem = lower.includes("://") ? "is a URL"
    : lower.includes("*") ? "uses a wildcard"
    : lower.includes("/") ? "includes a path"
    : ["github.com", "gitlab.com"].includes(lower.replace(/:443$/, "")) ? "is not a GitHub Enterprise host"
    : "is not a hostname";
  const quoted = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return `Line ${line} (${quoted}) ${problem}.`;
}
