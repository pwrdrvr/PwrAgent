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
let retainedBytes = 0;
function remove(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.onRemove?.();
  retainedBytes -= entry.bytes;
  entries.delete(key);
}

/** All stores and staged/delivery payloads share one process memory budget. */
export class TokenMiserOutputCache {
  private readonly namespace = randomUUID();
  private readonly idsByHandle = new Map<string, string>();

  resolveId(reference: string): string { return this.idsByHandle.get(reference) ?? reference; }

  publicReference(id: string): string {
    return entries.get(`${this.namespace}:${id}`)?.handle ?? id;
  }

  put(id: string, text: string, lifetime: "temporary" | "turn" = "temporary", detail?: string, handle?: string): boolean {
    const key = `${this.namespace}:${id}`;
    remove(key);
    const bytes = 256 + id.length * 2 + Buffer.byteLength(text, "utf8") + text.length * 2
      + (detail ? Buffer.byteLength(detail, "utf8") + detail.length * 2 : 0);
    if (bytes > TOKEN_MISER_OUTPUT_ENTRY_BYTES) return false;
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) remove(candidate);
    }
    while (retainedBytes + bytes > TOKEN_MISER_OUTPUT_BUDGET_BYTES) {
      remove(entries.keys().next().value!);
    }
    const timer = lifetime === "temporary"
      ? setTimeout(() => remove(key), TOKEN_MISER_OUTPUT_TTL_MS)
      : undefined;
    timer?.unref();
    if (handle) this.idsByHandle.set(handle, id);
    entries.set(key, {
      text, detail, bytes, timer,
      ...(handle ? { handle, onRemove: () => { this.idsByHandle.delete(handle); } } : {}),
      expiresAt: lifetime === "temporary" ? Date.now() + TOKEN_MISER_OUTPUT_TTL_MS : undefined,
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
