import { randomUUID } from "node:crypto";
import { partitionFederationCollection } from "./federation-collection-reads";

export const REPLACEMENT_MAX_BYTES = 16 * 1024 * 1024;
export const REPLACEMENT_MAX_PAGES = 256;
const STAGING_TTL_MS = 10_000;

export type FederationReplacementPage<T> = {
  generation: string;
  index: number;
  total: number;
  entries: T[];
};

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

/** Ordered WebSocket pages stage privately; only complete snapshots escape. */
export class FederationReplacementReceiver<T> {
  private pending?: {
    generation: string;
    total: number;
    next: number;
    expiresAt: number;
    bytes: number;
    entries: T[];
  };
  private completed?: string;

  clear(): void {
    this.pending = undefined;
    this.completed = undefined;
  }

  accept(page: FederationReplacementPage<T>, now = Date.now()): T[] | undefined {
    if (this.pending && now >= this.pending.expiresAt) this.pending = undefined;
    if (!page || typeof page.generation !== "string" || page.generation.length > 128
      || !Number.isInteger(page.index) || !Number.isInteger(page.total)
      || page.total < 1 || page.total > REPLACEMENT_MAX_PAGES
      || page.index < 0 || page.index >= page.total
      || !Array.isArray(page.entries) || page.entries.length > 100) {
      this.pending = undefined;
      throw new Error("Invalid Federation replacement page.");
    }
    if (page.generation === this.completed) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(page));
    if (bytes > 256 * 1024) {
      this.pending = undefined;
      throw new Error("Federation replacement page exceeds its byte budget.");
    }
    if (page.index === 0 && page.generation !== this.pending?.generation) {
      this.pending = {
        generation: page.generation, total: page.total, next: 0,
        expiresAt: now + STAGING_TTL_MS, bytes: 0, entries: [],
      };
    }
    const pending = this.pending;
    if (!pending || pending.generation !== page.generation) return undefined;
    if (page.total !== pending.total || page.index > pending.next) {
      this.pending = undefined;
      throw new Error("Incomplete Federation replacement sequence.");
    }
    if (page.index < pending.next) return undefined;
    if (pending.bytes + bytes > REPLACEMENT_MAX_BYTES) {
      this.pending = undefined;
      throw new Error("Federation replacement staging exceeds its byte budget.");
    }
    pending.bytes += bytes;
    pending.entries.push(...page.entries);
    pending.next += 1;
    if (pending.next !== pending.total) return undefined;
    this.pending = undefined;
    this.completed = page.generation;
    return pending.entries;
  }
}
