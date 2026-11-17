import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isRegisteredDecisionProvider } from "@pwragent/shared/openai-decisions";
import {
  recordBatchItem,
  type DecisionBatchCaller,
  type DecisionBatchItem,
  type DecisionBatchRecord,
  type DecisionBatchState,
} from "./decision-batches";

/**
 * Each decisions_invoke batch is also an append-only JSONL file in its
 * thread's storage: a `batch` header line, one `item` line per finished
 * input at full detail, and an `end` line. The agent can read the file
 * with its own tools, and decisions_batch_results reads it after a
 * restart. Inputs are not written; the caller has them, and they can be
 * 4 MB. Credentials never reach the file: items hold only what the
 * provider returned and redacted errors.
 */

export const DECISION_BATCH_FILE_LIMITS = {
  /** Result files kept per thread; the oldest are deleted as new batches start. */
  filesPerThread: 20,
} as const;

const BATCH_ID_PATTERN = /^batch_[A-Za-z0-9-]{1,80}$/u;
const FILE_SUFFIX = ".jsonl";
const FORMAT = 1;

/** Only an id PwrAgent could have generated ever becomes a path. */
export function isDecisionBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value);
}

export function decisionBatchFilePath(directory: string, batchId: string): string {
  if (!isDecisionBatchId(batchId)) throw new Error("Not a decision batch id.");
  return path.join(directory, `${batchId}${FILE_SUFFIX}`);
}

/**
 * Appends a batch's lines in order. A line queued while a write is in flight
 * joins the next write, so a busy batch costs a handful of appends rather
 * than one per item, and nothing waits on a timer. The first write creates
 * the directory and prunes the thread's oldest files.
 */
export class DecisionBatchFileWriter {
  private pending: string[] = [];
  private draining: Promise<void> | undefined;
  private started = false;
  failed = false;

  constructor(
    private readonly file: string,
    private readonly options: {
      /** Batch ids whose files must not be pruned, such as running batches. */
      keep: () => ReadonlySet<string>;
      onError: (error: unknown) => void;
    },
  ) {}

  append(entry: Record<string, unknown>): void {
    if (this.failed) return;
    this.pending.push(`${JSON.stringify(entry)}\n`);
    this.draining ??= this.drain();
  }

  /** Resolves once every queued line is written or the file has failed. */
  async settle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    try {
      if (!this.started) {
        this.started = true;
        const directory = path.dirname(this.file);
        await mkdir(directory, { recursive: true });
        await pruneDecisionBatchFiles(directory, this.options.keep());
      }
      while (this.pending.length > 0) {
        const chunk = this.pending.splice(0).join("");
        await appendFile(this.file, chunk, "utf8");
      }
    } catch (error) {
      this.failed = true;
      this.pending = [];
      this.options.onError(error);
    } finally {
      this.draining = undefined;
    }
  }
}

export function batchHeaderEntry(record: DecisionBatchRecord): Record<string, unknown> {
  return {
    type: "batch",
    format: FORMAT,
    batchId: record.batchId,
    decisionId: record.decisionId,
    name: record.name,
    version: record.version,
    provider: record.provider,
    count: record.count,
    concurrency: record.concurrency,
    background: record.background,
    createdAt: record.createdAt,
  };
}

export function batchItemEntry(item: DecisionBatchItem): Record<string, unknown> {
  return { type: "item", ...item };
}

export function batchEndEntry(record: DecisionBatchRecord): Record<string, unknown> {
  return {
    type: "end",
    state: record.state,
    succeeded: record.succeeded,
    failed: record.failed,
    skipped: record.skipped,
    ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {}),
    ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
  };
}

/** Batch ids with a file in the directory, any order. */
export async function listDecisionBatchFileIds(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(FILE_SUFFIX))
    .map((name) => name.slice(0, -FILE_SUFFIX.length))
    .filter(isDecisionBatchId);
}

/** Deletes the oldest files past the per-thread limit, never one in `keep`. */
async function pruneDecisionBatchFiles(directory: string, keep: ReadonlySet<string>): Promise<void> {
  const ids = await listDecisionBatchFileIds(directory);
  // The new batch's own file does not exist yet, so leave room for it.
  if (ids.length < DECISION_BATCH_FILE_LIMITS.filesPerThread) return;
  const dated = await Promise.all(ids.map(async (batchId) => {
    const file = decisionBatchFilePath(directory, batchId);
    const mtimeMs = await stat(file).then((info) => info.mtimeMs, () => 0);
    return { batchId, file, mtimeMs };
  }));
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const removable = dated.filter((entry) => !keep.has(entry.batchId));
  const excess = ids.length + 1 - DECISION_BATCH_FILE_LIMITS.filesPerThread;
  for (const entry of removable.slice(-excess)) {
    await rm(entry.file, { force: true });
  }
}

/**
 * Rebuilds a batch from its file. A line that does not parse, such as a
 * last line cut short by a crash, is skipped. A file with no end line was
 * running when PwrAgent stopped: it reads as cancelled, and every input
 * with no item line as skipped.
 */
export async function readDecisionBatchFile(
  file: string,
  caller: DecisionBatchCaller,
): Promise<DecisionBatchRecord | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let record: DecisionBatchRecord | undefined;
  let end: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (!record) {
      record = headerRecord(entry, caller, file);
      if (!record) return undefined;
      continue;
    }
    if (entry.type === "item") {
      const item = parseItem(entry, record.count);
      if (item) recordBatchItem(record, item);
    } else if (entry.type === "end") {
      end = entry;
    }
  }
  if (!record) return undefined;
  if (end) {
    record.state = isFinishedState(end.state) ? end.state : "cancelled";
    if (isFailure(end.stoppedBy)) record.stoppedBy = end.stoppedBy;
    if (typeof end.cancelReason === "string") record.cancelReason = end.cancelReason;
    if (typeof end.startedAt === "number") record.startedAt = end.startedAt;
    record.finishedAt = typeof end.finishedAt === "number" ? end.finishedAt : record.createdAt;
  } else {
    record.state = "cancelled";
    record.cancelReason = "PwrAgent stopped before the batch finished";
    record.finishedAt = await stat(file).then((info) => Math.round(info.mtimeMs), () => record!.createdAt);
  }
  const reason = record.stoppedBy
    ? `Skipped after ${record.stoppedBy.code}.`
    : `Skipped because ${record.cancelReason ?? "the batch was cancelled"}.`;
  for (let index = 0; index < record.count; index += 1) {
    if (record.results[index] === undefined) {
      recordBatchItem(record, { index, ok: false, code: "skipped", message: reason });
    }
  }
  return record;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function headerRecord(
  entry: Record<string, unknown>,
  caller: DecisionBatchCaller,
  file: string,
): DecisionBatchRecord | undefined {
  const count = entry.count;
  if (
    entry.type !== "batch"
    || typeof entry.batchId !== "string"
    || !isDecisionBatchId(entry.batchId)
    || typeof entry.decisionId !== "string"
    || typeof entry.name !== "string"
    || typeof entry.version !== "number"
    || !isRegisteredDecisionProvider(entry.provider)
    || typeof count !== "number"
    || !Number.isInteger(count)
    || count < 1
    || count > 10_000
    || typeof entry.createdAt !== "number"
  ) {
    return undefined;
  }
  return {
    batchId: entry.batchId,
    caller: { backend: caller.backend, threadId: caller.threadId },
    decisionId: entry.decisionId,
    name: entry.name,
    version: entry.version,
    provider: entry.provider,
    count,
    concurrency: typeof entry.concurrency === "number" ? entry.concurrency : 1,
    background: entry.background === true,
    state: "running",
    createdAt: entry.createdAt,
    resultsFile: file,
    results: new Array<DecisionBatchItem | undefined>(count).fill(undefined),
    succeeded: 0,
    failed: 0,
    skipped: 0,
    controller: new AbortController(),
  };
}

function parseItem(entry: Record<string, unknown>, count: number): DecisionBatchItem | undefined {
  const { type: _type, ...item } = entry;
  const index = item.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) return undefined;
  if (item.ok === true) return item as DecisionBatchItem;
  if (item.ok === false && typeof item.code === "string" && typeof item.message === "string") {
    return { index, ok: false, code: item.code, message: item.message };
  }
  return undefined;
}

function isFinishedState(value: unknown): value is Extract<DecisionBatchState, "completed" | "stopped" | "cancelled"> {
  return value === "completed" || value === "stopped" || value === "cancelled";
}

function isFailure(value: unknown): value is { code: string; message: string } {
  return Boolean(value)
    && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { message?: unknown }).message === "string";
}
