import {
  RENDERER_UPDATE_CAPACITY,
  RENDERER_UPDATE_EVENT_NAMES,
  type RendererUpdateEventCode,
  type RendererUpdateSnapshot,
} from "../../../shared/renderer-update-diagnostics";
export { RendererUpdateEvent } from "../../../shared/renderer-update-diagnostics";

export function createRendererUpdateRecorder(now: () => number = () => performance.now()) {
  const codes = new Uint8Array(RENDERER_UPDATE_CAPACITY);
  const first = new Float64Array(RENDERER_UPDATE_CAPACITY);
  const last = new Float64Array(RENDERER_UPDATE_CAPACITY);
  const repeats = new Uint32Array(RENDERER_UPDATE_CAPACITY);
  const scopes = new Array<string>(RENDERER_UPDATE_CAPACITY);
  const counts = new Float64Array(RENDERER_UPDATE_EVENT_NAMES.length);
  let size = 0;
  let next = 0;
  let total = 0;

  return {
    // Typed-array bytes plus one pointer per scope slot. Scope strings are
    // static labels or React useId values, never draft, thread or path data.
    storageBytes: codes.byteLength + first.byteLength + last.byteLength
      + repeats.byteLength + counts.byteLength + scopes.length * 8,
    record(this: void, event: RendererUpdateEventCode, scope = ""): void {
      const timestamp = now();
      total += 1;
      counts[event] += 1;
      const previous = (next + RENDERER_UPDATE_CAPACITY - 1) % RENDERER_UPDATE_CAPACITY;
      if (size > 0 && codes[previous] === event && scopes[previous] === scope
        && repeats[previous] < 0xffffffff) {
        repeats[previous] += 1;
        last[previous] = timestamp;
        return;
      }
      codes[next] = event;
      scopes[next] = scope;
      first[next] = timestamp;
      last[next] = timestamp;
      repeats[next] = 1;
      next = (next + 1) % RENDERER_UPDATE_CAPACITY;
      size = Math.min(size + 1, RENDERER_UPDATE_CAPACITY);
    },
    snapshot(this: void): RendererUpdateSnapshot {
      const events: RendererUpdateSnapshot["events"] = [];
      for (let offset = 0; offset < size; offset += 1) {
        const index = (next + RENDERER_UPDATE_CAPACITY - size + offset) % RENDERER_UPDATE_CAPACITY;
        events.push({
          event: codes[index] as RendererUpdateEventCode,
          scope: scopes[index],
          firstMs: Math.round(first[index] * 100) / 100,
          lastMs: Math.round(last[index] * 100) / 100,
          count: repeats[index],
        });
      }
      return {
        version: 1,
        capacity: RENDERER_UPDATE_CAPACITY,
        capturedAtMs: Math.round(now() * 100) / 100,
        total,
        counts: Array.from(counts),
        events,
      };
    },
  };
}

const recorder = createRendererUpdateRecorder();
export const recordRendererUpdate = recorder.record;
export const snapshotRendererUpdates = recorder.snapshot;
let lastError: RendererUpdateSnapshot | undefined;

function copySnapshot(snapshot: RendererUpdateSnapshot): RendererUpdateSnapshot {
  return { ...snapshot, counts: [...snapshot.counts], events: snapshot.events.map((event) => ({ ...event })) };
}

export function retainRendererUpdateFailure(snapshot: RendererUpdateSnapshot): void {
  lastError = copySnapshot(snapshot);
}

export function installRendererUpdateConsole(): () => void {
  const key = "__pwragentRendererUpdates";
  const previous = Object.getOwnPropertyDescriptor(window, key);
  const view = Object.freeze({
    snapshot: snapshotRendererUpdates,
    lastError: () => lastError ? copySnapshot(lastError) : undefined,
    eventNames: Object.freeze([...RENDERER_UPDATE_EVENT_NAMES]),
  });
  Object.defineProperty(window, key, { configurable: true, value: view });
  return () => {
    if (previous) Object.defineProperty(window, key, previous);
    else delete (window as unknown as Record<string, unknown>)[key];
  };
}
