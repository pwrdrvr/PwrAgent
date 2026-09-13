import { FORGE_KINDS, FORGE_PRODUCTS, type ForgeKind } from "@pwragent/shared";
import { parsePrRefFromUrl, type PrRef } from "./github-graphql-client";
import { parseGitLabMrUrl } from "./gitlab-pr-fetcher";

export type ForgePrRef = PrRef & { kind: ForgeKind; host: string };

const PR_URL_PARSERS: Record<ForgeKind, (url: string) => Omit<ForgePrRef, "kind"> | undefined> = {
  github: (url) => {
    const ref = parsePrRefFromUrl(url);
    return ref ? { ...ref, host: FORGE_PRODUCTS.github.saasHost } : undefined;
  },
  gitlab: parseGitLabMrUrl,
};

/** Unknown URLs have no provider; they must never fall through to GitHub. */
export function parseForgePrRefFromUrl(url: string): ForgePrRef | undefined {
  for (const kind of FORGE_KINDS) {
    const ref = PR_URL_PARSERS[kind](url);
    if (ref) return { ...ref, kind };
  }
  return undefined;
}
