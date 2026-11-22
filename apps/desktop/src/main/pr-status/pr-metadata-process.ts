import { IterableMapper } from "@shutterstock/p-map-iterable";
import { runGitCommand } from "../app-server/git-executable";

// All PR consumers share these slots, including filesystem probes, Git ref
// reads, and SSH config expansion. Timeouts start only after admission.
const MAX_ACTIVE_PROCESSES = 8;
const FILE_PROBE_TIMEOUT_MS = 250;
// Each ref probe awaits only one filesystem request at a time. Leave at
// least one libuv worker for the owner's other I/O, including Git startup.
const poolSize = process.env.UV_THREADPOOL_SIZE ?? "4";
const MAX_ACTIVE_FILE_PROBES = /^[0-9]{1,4}$/.test(poolSize)
  ? Math.max(0, Math.min(4, Number(poolSize)) - 1) : 0;
let activeFileProbes = 0;
let timedOutFileProbes = 0;
export const PR_METADATA_PRIORITY = { background: 0, page: 1, selected: 2 };

export type PrMetadataDemand = {
  signal?: AbortSignal;
  priority?: () => number;
};

type ProcessJob = {
  demand?: PrMetadataDemand;
  fileProbe: boolean;
  run: (fileSlot: boolean) => Promise<void>;
};
const waiting = new Set<ProcessJob>();
let wake: (() => void) | undefined;

function wakeProcessJobs(): void {
  const notify = wake;
  wake = undefined;
  notify?.();
}

async function* processJobs(): AsyncGenerator<{ job: ProcessJob; fileSlot: boolean }> {
  for (;;) {
    let next: ProcessJob | undefined;
    let priority = Number.NEGATIVE_INFINITY;
    const fileSlotAvailable = activeFileProbes < MAX_ACTIVE_FILE_PROBES;
    const fileProbesCanFinish = timedOutFileProbes < activeFileProbes;
    for (const job of waiting) {
      // Priority can change when a selected thread joins a queued lookup.
      const candidate = job.demand?.priority?.() ?? PR_METADATA_PRIORITY.background;
      // Wait behind healthy file probes without taking a mapper slot. A
      // selected reader or a fully stalled pool can go straight to Git.
      if (job.fileProbe && !fileSlotAvailable && fileProbesCanFinish && candidate < PR_METADATA_PRIORITY.selected) continue;
      if (candidate > priority) {
        next = job;
        priority = candidate;
      }
      if (priority === PR_METADATA_PRIORITY.selected) break;
    }
    if (!next) {
      await new Promise<void>((resolve) => { wake = resolve; });
      continue;
    }
    waiting.delete(next);
    const fileSlot = next.fileProbe && fileSlotAvailable;
    // Reserve before yielding because the mapper can pull several jobs.
    if (fileSlot) activeFileProbes++;
    yield { job: next, fileSlot };
  }
}

const processes = new IterableMapper(processJobs(), async ({ job, fileSlot }) => {
  await job.run(fileSlot);
  return true;
}, { concurrency: MAX_ACTIVE_PROCESSES, maxUnread: MAX_ACTIVE_PROCESSES });
void (async () => {
  for await (const _completed of processes) {
    // Each job settles its own caller. Drain results to keep pulling jobs.
  }
})();

async function enqueueProcess<T>(
  run: (fileSlot: boolean) => Promise<T>, demand?: PrMetadataDemand, fileProbe = false,
): Promise<T> {
  const signal = demand?.signal;
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      waiting.delete(job);
      reject(signal?.reason);
    };
    const job: ProcessJob = { demand, fileProbe, run: async (fileSlot) => {
      signal?.removeEventListener("abort", onAbort);
      if (fileSlot && signal?.aborted) {
        activeFileProbes--;
        wakeProcessJobs();
      }
      try {
        signal?.throwIfAborted();
        resolve(await run(fileSlot));
      } catch (error) {
        reject(error);
      }
    } };
    waiting.add(job);
    signal?.addEventListener("abort", onAbort, { once: true });
    wakeProcessJobs();
  });
}

export function runPrMetadataProcess<T>(run: () => Promise<T>, demand?: PrMetadataDemand): Promise<T> {
  return enqueueProcess(run, demand);
}

export async function runPrMetadataFileProbe<T>(
  read: (signal: AbortSignal) => Promise<T>, demand?: PrMetadataDemand,
): Promise<T | undefined> {
  demand?.signal?.throwIfAborted();
  if (MAX_ACTIVE_FILE_PROBES === 0) return undefined;
  return await enqueueProcess(async (fileSlot) => {
    if (!fileSlot) return undefined;
    const controller = new AbortController();
    const signal = demand?.signal ? AbortSignal.any([demand.signal, controller.signal]) : controller.signal;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve().then(() => read(signal)).catch(() => undefined).finally(() => {
      // The deadline can free the mapper slot while a libuv worker is still
      // blocked. Keep the filesystem reservation until the operation settles.
      activeFileProbes--;
      if (timedOut) timedOutFileProbes--;
      wakeProcessJobs();
    });
    try {
      const result = await Promise.race([operation, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          timedOutFileProbes++;
          controller.abort();
          wakeProcessJobs();
          resolve(undefined);
        }, FILE_PROBE_TIMEOUT_MS);
      })]);
      demand?.signal?.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }, demand, true);
}

export function runPrMetadataGit(
  cwd: string, args: string[], options: Parameters<typeof runGitCommand>[2], demand?: PrMetadataDemand,
): ReturnType<typeof runGitCommand> {
  return runPrMetadataProcess(() => runGitCommand(cwd, args, demand?.signal ? {
    ...options,
    beforeSpawn: () => {
      demand.signal?.throwIfAborted();
      options?.beforeSpawn?.();
    },
  } : options), demand);
}

/** A queued or running observation stays owned until its last reader leaves. */
export class SharedPrMetadataRead<T> {
  private readonly controller = new AbortController();
  private readonly readers = new Set<PrMetadataDemand>();
  private readonly result: Promise<T>;
  readonly signal = this.controller.signal;

  constructor(run: (demand: PrMetadataDemand) => Promise<T>) {
    this.result = Promise.resolve().then(() => run({
      signal: this.signal,
      priority: () => {
        let priority = PR_METADATA_PRIORITY.background;
        for (const reader of this.readers) priority = Math.max(priority, reader.priority?.() ?? PR_METADATA_PRIORITY.background);
        return priority;
      },
    }));
  }

  async read(demand?: PrMetadataDemand): Promise<T> {
    const signal = demand?.signal;
    signal?.throwIfAborted();
    const reader = { ...demand };
    this.readers.add(reader);
    if (reader.priority?.() === PR_METADATA_PRIORITY.selected) wakeProcessJobs();
    let onAbort: (() => void) | undefined;
    try {
      if (!signal) return await this.result;
      return await new Promise<T>((resolve, reject) => {
        onAbort = () => {
          this.remove(reader);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void this.result.then(resolve, reject);
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.remove(reader);
    }
  }

  private remove(reader: PrMetadataDemand): void {
    if (this.readers.delete(reader) && this.readers.size === 0) this.controller.abort();
  }
}
