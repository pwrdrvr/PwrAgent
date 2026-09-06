import { randomUUID } from "node:crypto";

export const TOKEN_MISER_OUTPUT_TTL_MS = 5 * 60_000;
export const TOKEN_MISER_OUTPUT_BUDGET_BYTES = 32 * 1024 * 1024;
export const TOKEN_MISER_OUTPUT_ENTRY_BYTES = 4 * 1024 * 1024;
const entries = new Map<string, { text: string; bytes: number; expiresAt: number; timer: NodeJS.Timeout }>();
let retainedBytes = 0;
function remove(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  retainedBytes -= entry.bytes;
  entries.delete(key);
}

/** All stores and staged/delivery payloads share one process memory budget. */
export class TokenMiserOutputCache {
  private readonly namespace = randomUUID();

  put(id: string, text: string): boolean {
    const key = `${this.namespace}:${id}`;
    remove(key);
    const bytes = 256 + id.length * 2 + Buffer.byteLength(text, "utf8") + text.length * 2;
    if (bytes > TOKEN_MISER_OUTPUT_ENTRY_BYTES) return false;
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt <= Date.now()) remove(candidate);
    }
    while (retainedBytes + bytes > TOKEN_MISER_OUTPUT_BUDGET_BYTES) {
      remove(entries.keys().next().value!);
    }
    const timer = setTimeout(() => remove(key), TOKEN_MISER_OUTPUT_TTL_MS);
    timer.unref();
    entries.set(key, { text, bytes, expiresAt: Date.now() + TOKEN_MISER_OUTPUT_TTL_MS, timer });
    retainedBytes += bytes;
    return true;
  }

  get(id: string): string | undefined {
    const key = `${this.namespace}:${id}`;
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      remove(key);
      return undefined;
    }
    return entry?.text;
  }

  expiresAt(id: string): number | undefined {
    if (this.get(id) === undefined) return undefined;
    return entries.get(`${this.namespace}:${id}`)?.expiresAt;
  }

  remove(id: string): void { remove(`${this.namespace}:${id}`); }
}
