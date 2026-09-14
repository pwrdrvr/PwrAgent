import { FORGE_KINDS, FORGE_PRODUCTS, forgeKindForRemoteHost, normalizePullRequestProvider, type ForgeKind } from "@pwragent/shared";

/** Attachment identities can describe hosts whose status transport is not
 * supported (such as GHE). Parsing a link does not enable network access. */
export type PullRequestRepositoryRef = {
  kind?: ForgeKind;
  provider: string;
  org: string;
  repo: string;
  urlBase?: string;
};

export type PullRequestReferenceIdentity = PullRequestRepositoryRef & {
  number: number;
  url: string;
};

export function parsePullRequestReferenceUrl(
  value: string | undefined,
): PullRequestReferenceIdentity | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const markerIndex = segments.findIndex((segment) =>
    FORGE_KINDS.some((entry) => FORGE_PRODUCTS[entry].changeRequestPath.split("/").at(-1) === segment),
  );
  const kind = FORGE_KINDS.find((entry) =>
    FORGE_PRODUCTS[entry].changeRequestPath.split("/").at(-1) === segments[markerIndex],
  );
  if (!kind) return undefined;
  if (markerIndex <= 0 || markerIndex >= segments.length - 1) {
    return undefined;
  }
  const number = Number.parseInt(segments[markerIndex + 1] ?? "", 10);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  const repoIndex = segments[markerIndex - 1] === "-"
    ? markerIndex - 2
    : markerIndex - 1;
  if (repoIndex <= 0) {
    return undefined;
  }
  const org = segments.slice(0, repoIndex).join("/");
  const repo = segments[repoIndex];
  if (!org || !repo) {
    return undefined;
  }
  return {
    kind,
    provider: normalizePullRequestProvider(parsed.hostname),
    org,
    repo,
    number,
    url: trimmed,
    urlBase: `${parsed.protocol}//${parsed.host}`,
  };
}

export function buildPullRequestReferenceUrl(ref: PullRequestRepositoryRef & { number: number }): string {
  const provider = normalizePullRequestProvider(ref.provider);
  const base = ref.urlBase?.replace(/\/+$/, "") || `https://${provider}`;
  const encodedPath = [...ref.org.split("/"), ref.repo]
    .map((part) => encodeURIComponent(part))
    .join("/");
  // URL-less unknown hosts retain the historical GitHub/GHE attachment
  // convention. This builds a link only; it never authorizes a transport.
  const kind = ref.kind ?? forgeKindForRemoteHost(provider) ?? "github";
  const marker = FORGE_PRODUCTS[kind].changeRequestPath;
  return `${base}/${encodedPath}/${marker}/${ref.number}`;
}

