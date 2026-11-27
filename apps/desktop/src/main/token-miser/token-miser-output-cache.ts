import { randomUUID } from "node:crypto";

export const TOKEN_MISER_OUTPUT_TTL_MS = 5 * 60_000;
export const TOKEN_MISER_OUTPUT_BUDGET_BYTES = 32 * 1024 * 1024;
export const TOKEN_MISER_OUTPUT_ENTRY_BYTES = 4 * 1024 * 1024;
type CachedOutput = {
  text: string;
  detail?: string;
  utf8?: Buffer;
  bytes: number;
  expiresAt?: number;
  timer?: NodeJS.Timeout;
  handle?: string;
  onRemove?: () => void;
};
const entries = new Map<string, CachedOutput>();
const temporaryKeys = new Set<string>();
let retainedBytes = 0;
function remove(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    temporaryKeys.delete(key);
  }
  entry.onRemove?.();
  retainedBytes -= entry.bytes;
  entries.delete(key);
}

/** All stores and staged/delivery payloads share one process memory budget. */
export class TokenMiserOutputCache {
  private readonly namespace = randomUUID();
  private readonly idsByHandle = new Map<string, string>();
  private readonly liveGroupCounts = new Map<string, number>();

  hasNativeGroup(key: string): boolean { return this.liveGroupCounts.has(key); }

  resolveId(reference: string): string { return this.idsByHandle.get(reference) ?? reference; }

  publicReference(id: string): string {
    return entries.get(`${this.namespace}:${id}`)?.handle ?? id;
  }

  put(id: string, text: string, lifetime: "temporary" | "turn" = "temporary", detail?: string, handle?: string, groupKey?: string): boolean {
    const key = `${this.namespace}:${id}`;
    remove(key);
    const bytes = 256 + id.length * 2 + Buffer.byteLength(text, "utf8") + text.length * 2
      + (detail ? Buffer.byteLength(detail, "utf8") + detail.length * 2 : 0);
    if (bytes > TOKEN_MISER_OUTPUT_ENTRY_BYTES) return false;
    const now = Date.now();
    // All temporary entries have the same TTL and are inserted in expiry order.
    // Reclaim expired entries before considering live payloads for FIFO eviction.
    for (const candidate of temporaryKeys) {
      if (entries.get(candidate)!.expiresAt! > now) break;
      remove(candidate);
    }
    while (retainedBytes + bytes > TOKEN_MISER_OUTPUT_BUDGET_BYTES) {
      remove(entries.keys().next().value!);
    }
    const timer = lifetime === "temporary"
      ? setTimeout(() => remove(key), TOKEN_MISER_OUTPUT_TTL_MS)
      : undefined;
    timer?.unref();
    if (timer) temporaryKeys.add(key);
    if (handle) this.idsByHandle.set(handle, id);
    if (groupKey) this.liveGroupCounts.set(groupKey, (this.liveGroupCounts.get(groupKey) ?? 0) + 1);
    entries.set(key, {
      text, detail, bytes, timer,
      handle,
      onRemove: handle || groupKey ? () => {
        if (handle) this.idsByHandle.delete(handle);
        if (groupKey) {
          const remaining = this.liveGroupCounts.get(groupKey)! - 1;
          if (remaining) this.liveGroupCounts.set(groupKey, remaining);
          else this.liveGroupCounts.delete(groupKey);
        }
      } : undefined,
      expiresAt: lifetime === "temporary" ? now + TOKEN_MISER_OUTPUT_TTL_MS : undefined,
    });
    retainedBytes += bytes;
    return true;
  }

  get(id: string): string | undefined {
    const key = `${this.namespace}:${id}`;
    const entry = entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      remove(key);
      return undefined;
    }
    return entry?.text;
  }

  getDetail(id: string): string | undefined {
    if (this.get(id) === undefined) return undefined;
    return entries.get(`${this.namespace}:${id}`)?.detail;
  }

  bytePage(id: string, offset: number) {
    if (this.get(id) === undefined) return undefined;
    const entry = entries.get(`${this.namespace}:${id}`)!;
    // put() budgets both the string and its UTF-8 size. Encode once across pages.
    const bytes = entry.utf8 ??= Buffer.from(entry.text);
    return { offset, totalBytes: bytes.length, base64: bytes.subarray(offset, offset + 1024).toString("base64") };
  }

  remove(id: string): void { remove(`${this.namespace}:${id}`); }
}
