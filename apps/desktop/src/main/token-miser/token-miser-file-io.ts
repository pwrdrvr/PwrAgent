// This budget belongs to the process, not a scan or store instance. On macOS,
// child-process stdio descriptors above 10239 can make spawn fail with EBADF
// even before the process reaches its open-file limit.
const MAX_CONCURRENT_FILE_OPERATIONS = 16;
const SCAN_WORKERS = 8;
let activeOperations = 0;
const waiters = new Set<() => void>();

export async function withTokenMiserFileOperation<T>(run: () => Promise<T>): Promise<T> {
  if (activeOperations >= MAX_CONCURRENT_FILE_OPERATIONS) {
    await new Promise<void>((resolve) => { waiters.add(resolve); });
  } else {
    activeOperations += 1;
  }
  try {
    return await run();
  } finally {
    const next = waiters.values().next().value;
    if (next) {
      // Transfer the slot; a new caller must not take it before next resumes.
      waiters.delete(next);
      next();
    } else {
      activeOperations -= 1;
    }
  }
}

export async function mapTokenMiserFiles<T>(
  files: readonly string[],
  read: (file: string) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(files.length);
  let nextIndex = 0;
  // A worker owns one operation until it settles. Do not enqueue a promise
  // for every retained file into the process-wide budget.
  const workers = await Promise.allSettled(Array.from(
    { length: Math.min(SCAN_WORKERS, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const index = nextIndex++;
        results[index] = await read(files[index]!);
      }
    },
  ));
  for (const worker of workers) {
    if (worker.status === "rejected") throw worker.reason;
  }
  return results;
}
