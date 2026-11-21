import { IterableMapper } from "@shutterstock/p-map-iterable";
import { runGitCommand } from "../app-server/git-executable";

// All PR consumers share these slots, including Git ref reads and SSH config
// expansion. The command's own timeout starts only after it gets a slot.
const MAX_ACTIVE_PROCESSES = 8;

export type PrMetadataDemand = {
  signal?: AbortSignal;
  foreground?: () => boolean;
};

type ProcessJob = { demand?: PrMetadataDemand; run: () => Promise<void> };
const waiting = new Set<ProcessJob>();
let wake: (() => void) | undefined;

async function* processJobs(): AsyncGenerator<ProcessJob> {
  for (;;) {
    let next = waiting.values().next().value;
    if (!next) {
      await new Promise<void>((resolve) => { wake = resolve; });
      continue;
    }
    for (const job of waiting) {
      // Priority can change when a selected thread joins a queued lookup.
      if (job.demand?.foreground?.()) {
        next = job;
        break;
      }
    }
    waiting.delete(next);
    yield next;
  }
}

const processes = new IterableMapper(processJobs(), async (job) => {
  await job.run();
  return true;
}, { concurrency: MAX_ACTIVE_PROCESSES, maxUnread: MAX_ACTIVE_PROCESSES });
void (async () => {
  for await (const _completed of processes) {
    // Each job settles its own caller. Drain results to keep pulling jobs.
  }
})();

export async function runPrMetadataProcess<T>(run: () => Promise<T>, demand?: PrMetadataDemand): Promise<T> {
  const signal = demand?.signal;
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      waiting.delete(job);
      reject(signal?.reason);
    };
    const job: ProcessJob = { demand, run: async () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        signal?.throwIfAborted();
        resolve(await run());
      } catch (error) {
        reject(error);
      }
    } };
    waiting.add(job);
    signal?.addEventListener("abort", onAbort, { once: true });
    const notify = wake;
    wake = undefined;
    notify?.();
  });
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
      foreground: () => {
        for (const reader of this.readers) if (reader.foreground?.()) return true;
        return false;
      },
    }));
  }

  async read(demand?: PrMetadataDemand): Promise<T> {
    const signal = demand?.signal;
    signal?.throwIfAborted();
    const reader = { ...demand };
    this.readers.add(reader);
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
