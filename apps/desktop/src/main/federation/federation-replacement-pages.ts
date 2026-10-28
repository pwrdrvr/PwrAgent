import { randomUUID } from "node:crypto";
import { REPLACEMENT_MAX_BYTES, REPLACEMENT_MAX_PAGES, type FederationReplacementPage } from "@pwragent/federation/federation-replacement-receiver";
import { partitionFederationCollection } from "./federation-collection-reads";

export * from "@pwragent/federation/federation-replacement-receiver";

export function replacementPages<T>(entries: readonly T[]): FederationReplacementPage<T>[] {
  const pages = partitionFederationCollection(entries);
  if (!pages.length) pages.push([]);
  const generation = randomUUID();
  const result = pages.map((page, index) => ({ generation, index, total: pages.length, entries: page }));
  if (pages.length > REPLACEMENT_MAX_PAGES
    || result.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0) > REPLACEMENT_MAX_BYTES) {
    throw new Error("Federation replacement exceeds its complete-snapshot budget.");
  }
  return result;
}
