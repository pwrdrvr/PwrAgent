/** Bounded admission with input-order results; drain admitted work on failure. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try {
        results[index] = await operation(values[index]!, index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }));
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
