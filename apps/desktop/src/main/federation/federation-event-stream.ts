import type { AgentEvent } from "@pwragent/shared";

export const FEDERATION_EVENT_STREAM_METHOD = "backend.eventStream";

export type FederationEventStreamCursor = { epoch: string; sequence: number };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Change =
  | { path: string[]; value: Json }
  | { path: string[]; remove: true }
  | { path: string[]; start: number; deleteCount: number; items: Json[] };

export type FederationStreamPayload = AgentEvent & {
  stream?: FederationEventStreamCursor;
  accountingPatch?: { baseSequence: number; changes: Change[] };
};

function equal(left: Json, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changesBetween(previous: Json, next: Json, path: string[] = []): Change[] {
  if (equal(previous, next)) return [];
  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length === next.length) {
      return next.flatMap((value, index) => changesBetween(previous[index]!, value, [...path, String(index)]));
    }
    let start = 0;
    while (start < Math.min(previous.length, next.length) && equal(previous[start]!, next[start]!)) start += 1;
    let tail = 0;
    while (tail < Math.min(previous.length, next.length) - start
      && equal(previous[previous.length - tail - 1]!, next[next.length - tail - 1]!)) tail += 1;
    const splice: Change[] = [{ path, start, deleteCount: previous.length - start - tail, items: next.slice(start, next.length - tail) }];
    // A new invocation and a counter update can occur together. A single
    // middle splice would resend everything between those two changes.
    const overlap = Math.min(previous.length, next.length);
    const indexed: Change[] = [
      ...next.slice(0, overlap).flatMap((value, index) => changesBetween(previous[index]!, value, [...path, String(index)])),
      { path, start: overlap, deleteCount: previous.length - overlap, items: next.slice(overlap) },
    ];
    return JSON.stringify(indexed).length < JSON.stringify(splice).length ? indexed : splice;
  }
  if (previous !== null && next !== null && typeof previous === "object" && typeof next === "object"
    && !Array.isArray(previous) && !Array.isArray(next)) {
    return [
      ...Object.keys(previous).filter((key) => !Object.hasOwn(next, key)).map((key): Change => ({ path: [...path, key], remove: true })),
      ...Object.entries(next).flatMap(([key, value]) => Object.hasOwn(previous, key)
        ? changesBetween(previous[key]!, value, [...path, key])
        : [{ path: [...path, key], value }]),
    ];
  }
  return [{ path, value: next }];
}

function applyChanges(previous: Json, changes: Change[]): Json {
  let result = structuredClone(previous);
  for (const change of changes) {
    if (!Array.isArray(change.path)
      || change.path.some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))) {
      throw new Error("Invalid accounting patch path.");
    }
    let target = result;
    const parents = "start" in change ? change.path : change.path.slice(0, -1);
    for (const key of parents) {
      if (target === null || typeof target !== "object" || !Object.hasOwn(target, key)) throw new Error("Missing accounting patch path.");
      target = (target as Record<string, Json>)[key]!;
    }
    if ("start" in change) {
      if (!Array.isArray(target) || !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.deleteCount)
        || change.start < 0 || change.deleteCount < 0 || change.start + change.deleteCount > target.length
        || !Array.isArray(change.items)) throw new Error("Invalid accounting array patch.");
      target.splice(change.start, change.deleteCount, ...change.items);
    } else if (change.path.length === 0 && "value" in change) {
      result = change.value;
    } else {
      if (target === null || typeof target !== "object") throw new Error("Invalid accounting object patch.");
      const key = change.path.at(-1)!;
      if ("remove" in change) delete (target as Record<string, Json>)[key];
      else (target as Record<string, Json>)[key] = change.value;
    }
  }
  return result;
}

/** One connection/subscription lifetime. No disk writes or transcript retention.
 * Bounds apply on both ends; a missing baseline asks for a fresh subscription.
 */
export class FederationAccountingStream {
  private readonly baselines = new Map<string, { params: Json; sequence: number; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxEntries = 32) {}

  private key(event: AgentEvent): string | undefined {
    return event.notification.method === "thread/pricing/updated" || event.notification.method === "thread/toolAccounting/updated"
      ? JSON.stringify([event.backend, event.notification.params.threadId, event.notification.method]) : undefined;
  }

  private retain(key: string, params: Json, sequence: number): void {
    this.bytes -= this.baselines.get(key)?.bytes ?? 0;
    this.baselines.delete(key);
    const serialized = JSON.stringify(params);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.maxBytes) return;
    while (this.baselines.size && (this.bytes + bytes > this.maxBytes || this.baselines.size >= this.maxEntries)) {
      const oldest = this.baselines.keys().next().value!;
      this.bytes -= this.baselines.get(oldest)!.bytes;
      this.baselines.delete(oldest);
    }
    this.baselines.set(key, { params: JSON.parse(serialized) as Json, sequence, bytes });
    this.bytes += bytes;
  }

  encode(event: AgentEvent, stream: FederationEventStreamCursor): FederationStreamPayload {
    const full = { ...event, stream };
    const key = this.key(event);
    if (!key) return full;
    const next = JSON.parse(JSON.stringify(event.notification.params)) as Json;
    const previous = this.baselines.get(key);
    const patch = previous ? {
      ...full,
      notification: { method: event.notification.method, params: { threadId: (event.notification.params as Record<string, unknown>).threadId } },
      accountingPatch: { baseSequence: previous.sequence, changes: changesBetween(previous.params, next) },
    } as FederationStreamPayload : undefined;
    this.retain(key, next, stream.sequence);
    return patch && Buffer.byteLength(JSON.stringify(patch)) < Buffer.byteLength(JSON.stringify(full)) ? patch : full;
  }

  decode(event: FederationStreamPayload): AgentEvent | undefined {
    const key = this.key(event);
    if (event.accountingPatch && (!key || !event.stream)) return undefined;
    let params = event.notification.params as unknown as Json;
    if (event.accountingPatch) {
      const previous = this.baselines.get(key!);
      if (!previous || previous.sequence !== event.accountingPatch.baseSequence) return undefined;
      try {
        params = applyChanges(previous.params, event.accountingPatch.changes);
        if (params === null || typeof params !== "object" || Array.isArray(params)
          || params.threadId !== (event.notification.params as Record<string, unknown>).threadId) return undefined;
      } catch {
        return undefined;
      }
    }
    if (key && event.stream) this.retain(key, params, event.stream.sequence);
    return { backend: event.backend, notification: { method: event.notification.method, params } } as AgentEvent;
  }
}
