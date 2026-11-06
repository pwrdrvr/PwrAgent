import { IterableMapper } from "@shutterstock/p-map-iterable";

/** Collect streamed results in input order and drain admitted work on failure. */
export async function collectConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let failed = false;
  let failure: unknown;

  function* remaining() {
    for (const value of values) {
      if (failed) return;
      yield value;
    }
  }

  // IterableMapper owns concurrency and backpressure. Catch inside the mapper
  // so iteration drains active siblings instead of rejecting before they settle.
  const mapped = new IterableMapper(remaining(), async (value, index) => {
    try {
      return { ok: true as const, index, value: await operation(value, index) };
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
      return { ok: false as const };
    }
  }, { concurrency, maxUnread: concurrency });
  for await (const result of mapped) {
    if (result.ok) results[result.index] = result.value;
  }
  if (failed) throw failure;
  return results;
}

/** Join independent branches without releasing lifecycle ownership early. */
export async function joinConcurrent<T extends readonly unknown[]>(
  work: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(work);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** FIFO byte admission. Callers retain the reservation until buffers die. */
export function createByteBudget(capacity: number) {
  let available = capacity;
  const waiting: { bytes: number; resolve: () => void }[] = [];
  const admit = () => {
    while (waiting.length > 0 && waiting[0]!.bytes <= available) {
      const next = waiting.shift()!;
      available -= next.bytes;
      next.resolve();
    }
  };
  return async <T>(bytes: number, action: () => Promise<T>): Promise<T> => {
    const reserved = Math.max(1, Math.min(capacity, bytes));
    await new Promise<void>((resolve) => { waiting.push({ bytes: reserved, resolve }); admit(); });
    try { return await action(); }
    finally { available += reserved; admit(); }
  };
}
