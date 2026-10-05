type DiffFit = "stretch" | "anchor";

export type PixelDiffRequest = {
  id: number;
  before: Blob;
  after: Blob;
  width: number;
  height: number;
  fit: DiffFit;
};

export type PixelDiffReply =
  | { id: number; ok: true; png: Blob; changed: number; total: number }
  | { id: number; ok: false; error: string };

export type PixelDiffResult = { png: Blob; changed: number; total: number };

/**
 * A promise in front of `pixel-diff.worker.ts`. One worker for the renderer,
 * created on first use and kept: a fresh one per comparison would re-parse
 * pixelmatch on every Diff.
 *
 * Inlined as a blob-URL worker (`?worker&inline`) rather than a separate
 * chunk, so it starts the same way from the dev server and from a packaged
 * `file://` renderer. Imported lazily, so nothing loads it until a Diff is
 * actually asked for — and the test environment, which has no Worker, never
 * evaluates it at all.
 */
let worker: Promise<Worker> | undefined;
let nextId = 0;
const pending = new Map<number, {
  resolve: (value: PixelDiffResult) => void;
  reject: (reason: Error) => void;
}>();

function ensureWorker(): Promise<Worker> {
  if (worker) {
    return worker;
  }
  const loading = import("./pixel-diff.worker?worker&inline").then(({ default: PixelDiffWorker }) => {
    const created = new PixelDiffWorker();
    created.addEventListener("message", (event: MessageEvent<PixelDiffReply>) => {
      const reply = event.data;
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      if (reply.ok) {
        waiting.resolve({ png: reply.png, changed: reply.changed, total: reply.total });
      } else {
        waiting.reject(new Error(reply.error));
      }
    });
    created.addEventListener("error", () => {
      // A worker-level failure kills every request on it, so nothing is left
      // waiting on a reply that can no longer come.
      for (const waiting of pending.values()) {
        waiting.reject(new Error("the comparison crashed"));
      }
      pending.clear();
      created.terminate();
      worker = undefined;
    });
    return created;
  });
  // A failed import (a chunk that would not load) is not cached: the next
  // Diff tries again instead of failing for the rest of the session.
  loading.catch(() => {
    if (worker === loading) worker = undefined;
  });
  worker = loading;
  return loading;
}

export async function computePixelDiff(
  request: Omit<PixelDiffRequest, "id">,
): Promise<PixelDiffResult> {
  if (typeof Worker === "undefined") {
    throw new Error("not supported here");
  }
  const active = await ensureWorker();
  const id = (nextId += 1);
  return await new Promise<PixelDiffResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ ...request, id } satisfies PixelDiffRequest);
  });
}
