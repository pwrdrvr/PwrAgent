const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
export const CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS = 16;

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
  const invalidLines: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string" && !entry.trim()) continue;
    const host = normalizeGithubEnterpriseHost(entry);
    // A host must be usable verbatim as the host of an HTTPS run URL.
    if (host && url.parse(`https://${host}`)?.host === host) hosts.add(host);
    else invalidLines.push(index + 1);
  }
  if (invalidLines.length) {
    const lines = invalidLines.slice(0, 8).join(", ");
    const more = invalidLines.length > 8 ? ` and ${invalidLines.length - 8} more` : "";
    return { hosts: [...hosts], error: `Invalid host entries on lines ${lines}${more}. Enter exact GitHub Enterprise hostnames with an optional port.` };
  }
  if (hosts.size > CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS) {
    return { hosts: [...hosts], error: `Enter up to ${CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS} distinct hosts.` };
  }
  return { hosts: [...hosts] };
}
