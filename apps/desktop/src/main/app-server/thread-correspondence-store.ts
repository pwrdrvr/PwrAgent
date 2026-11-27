import { pathToFileURL } from "node:url";
import { toTranscriptImageProtocolUrl } from "../transcript-images";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerThreadMessage,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadReplay,
  AppServerThreadTurnMetadata,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  buildThreadCorrespondenceHeading,
  formatStackNotice,
  type StackNotice,
  type ThreadCorrespondenceState,
} from "@pwragent/shared/contracts/thread-system-messages";
import { buildThreadMarkdownLink } from "@pwragent/shared/contracts/thread-link";
import { readUuidV7Timestamp } from "@pwragent/shared/uuid-v7";
import { isUsageActivityEntry, usageActivityScope } from "./overlay-transcript-entries";
import { readOptionalString, readRecord } from "./backend-registry-notification-values";

export function stackFileReadsFromItem(value: unknown): string[] {
  const item = readRecord(value);
  if (!item || item.success === false || item.status === "failed" || item.status === "declined"
    || item.status === "cancelled" || (typeof item.exitCode === "number" && item.exitCode !== 0)) return [];
  const paths = (Array.isArray(item.commandActions) ? item.commandActions : []).flatMap((action) => {
    const entry = readRecord(action);
    return entry?.type === "read" && typeof entry.path === "string" ? [entry.path] : [];
  });
  if (item.commandAction === "read" || /^(?:read|read_file|view_file)$/i.test(readOptionalString(item, ["toolName"]) ?? "")) {
    const file = readOptionalString(readRecord(item.arguments ?? item.data), ["path", "file_path", "filePath"]);
    if (file) paths.push(file);
  }
  return paths;
}

type ThreadRef = { backend: AppServerBackendKind; threadId: string; instanceId?: string; title?: string };
export type CorrespondenceRecord = {
  id: string;
  source: ThreadRef;
  destination: ThreadRef;
  input: AppServerTurnInputItem[];
  createdAt: number;
  state: ThreadCorrespondenceState;
  queueEntryId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceItemId?: string;
  stackNotice?: StackNotice;
  stackDelivered?: boolean;
};
type Status = Pick<CorrespondenceRecord, "state"> & Partial<Pick<CorrespondenceRecord, "destination" | "queueEntryId" | "turnId" | "stackDelivered">>;
type Event = { type: "message"; record: CorrespondenceRecord } | { type: "status"; id: string; status: Status };

type ReceiptPosition = { id: string; time: number; order: number };
type ReplayIndex = {
  byTurn: Map<string, ReceiptPosition[]>;
  unbound: ReceiptPosition[];
  stackCompletions: ReceiptPosition[];
};
type TurnTimings = {
  byId: Map<string, AppServerThreadTurnMetadata>;
  // Negate timestamps so descending history pages can append to the index.
  newestFirst?: Array<{ id: string; time: number }>;
};

function timeBoundary(sorted: readonly { time: number }[], time: number, afterEqual = false): number {
  let start = 0;
  let end = sorted.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    const candidate = sorted[middle]!.time;
    if (candidate < time || (afterEqual && candidate === time)) start = middle + 1;
    else end = middle;
  }
  return start;
}

function receiptBucket(index: ReplayIndex, record: CorrespondenceRecord): ReceiptPosition[] {
  if (record.stackNotice?.completion) return index.stackCompletions;
  if (!record.sourceTurnId) return index.unbound;
  let bucket = index.byTurn.get(record.sourceTurnId);
  if (!bucket) {
    bucket = [];
    index.byTurn.set(record.sourceTurnId, bucket);
  }
  return bucket;
}

function byReceiptTime(a: ReceiptPosition, b: ReceiptPosition): number {
  return a.time - b.time || a.order - b.order;
}

/** PwrAgent-owned supplemental correspondence, never provider history or SQLite. */
export class ThreadCorrespondenceStore {
  private readonly records = new Map<string, Map<string, CorrespondenceRecord>>();
  private readonly replayIndexes = new Map<string, ReplayIndex>();
  private readonly stackReads = new Map<string, Set<string>>();
  private readonly lastStackMove = new Map<string, string>();
  private readonly pendingStackReads = new Map<string, Set<string>>();
  // Retain only turn timing metadata across page reads, never transcript rows.
  // A newer page's turn start bounds the last turn of the next older page.
  private readonly turnTimings = new Map<string, TurnTimings>();
  constructor(private readonly directory?: string) {}

  private key(source: ThreadRef): string {
    return createHash("sha256").update(JSON.stringify([source.backend, source.instanceId ?? null, source.threadId])).digest("hex");
  }

  private load(source: ThreadRef): Map<string, CorrespondenceRecord> {
    const key = this.key(source);
    const cached = this.records.get(key);
    if (cached) return cached;
    const records = new Map<string, CorrespondenceRecord>();
    if (this.directory) {
      const file = path.join(this.directory, `${key}.jsonl`);
      let data: string;
      try { data = readFileSync(file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = "";
      }
      for (const [index, line] of data.split("\n").entries()) {
        if (!line) continue;
        let event: Event | { type: "stackReads"; paths: string[] };
        try { event = JSON.parse(line) as typeof event; }
        catch { throw new Error(`Invalid PwrAgent correspondence record at ${file}:${index + 1}`); }
        if (event.type === "message") {
          records.set(event.record.id, event.record);
          if (event.record.stackNotice && !event.record.stackNotice.completion) {
            this.lastStackMove.set(key, event.record.id);
            this.stackReads.delete(key);
          }
        } else if (event.type === "stackReads") {
          this.stackReads.set(key, new Set(event.paths.slice(-256)));
        }
        else if (event.type === "status") {
          const record = records.get(event.id);
          if (record) records.set(event.id, { ...record, ...event.status });
        } else throw new Error(`Invalid PwrAgent correspondence event at ${file}:${index + 1}`);
      }
      try {
        const saved = JSON.parse(readFileSync(path.join(this.directory, `${key}.stack-reads.json`), "utf8")) as {
          after?: string; paths?: unknown;
        };
        if (saved.after === this.lastStackMove.get(key) && Array.isArray(saved.paths)) {
          this.stackReads.set(key, new Set(saved.paths.slice(-256).filter((file): file is string => typeof file === "string")));
        }
      } catch {
        // Read provenance is optional and must not block transcript loading.
      }
    }
    this.records.set(key, records);
    return records;
  }

  private append(source: ThreadRef, event: Event, flush = false): void {
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(this.directory, `${this.key(source)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600, flush });
  }

  record(record: CorrespondenceRecord): boolean {
    const records = this.load(record.source);
    const replacing = records.has(record.id);
    if (record.stackNotice && replacing) return false;
    this.append(record.source, { type: "message", record }, Boolean(record.stackNotice));
    const saved = structuredClone(record);
    const key = this.key(record.source);
    const index = this.replayIndexes.get(key);
    if (index && replacing) this.replayIndexes.delete(key);
    else if (index) {
      const bucket = receiptBucket(index, record);
      const position = { id: record.id, time: record.createdAt, order: records.size };
      if ((record.sourceTurnId && !record.stackNotice?.completion)
        || !bucket.length || bucket.at(-1)!.time <= position.time) bucket.push(position);
      else bucket.splice(timeBoundary(bucket, position.time, true), 0, position);
    }
    records.set(record.id, saved);
    if (record.stackNotice && !record.stackNotice.completion) {
      this.lastStackMove.set(this.key(record.source), record.id);
      this.stackReads.delete(this.key(record.source));
      this.pendingStackReads.delete(this.key(record.source));
    }
    return true;
  }

  pendingStackNotices(source: ThreadRef): Array<{ id: string; text: string }> {
    return [...this.load(source).values()].flatMap((record) =>
      record.stackNotice && !record.stackNotice.completion && !record.stackDelivered ? [{ id: record.id, text: formatStackNotice(record.stackNotice) }] : []);
  }

  hasStackNotice(source: ThreadRef, id: string): boolean {
    return Boolean(this.load(source).get(id)?.stackNotice);
  }

  rememberStackReads(source: ThreadRef, paths: readonly string[]): void {
    const key = this.key(source);
    const next = this.pendingStackReads.get(key) ?? new Set<string>();
    for (const file of paths) {
      if (!file || file.length > 4096 || file.includes("\0")) continue;
      next.delete(file);
      next.add(file);
      if (next.size > 256) next.delete(next.values().next().value!);
    }
    if (!next.size) return;
    this.pendingStackReads.set(key, next);
    if (this.pendingStackReads.size > 128) this.pendingStackReads.delete(this.pendingStackReads.keys().next().value!);
  }

  flushStackReads(source: ThreadRef): void {
    const key = this.key(source);
    const pending = this.pendingStackReads.get(key);
    if (!pending) return;
    this.load(source);
    const previous = this.stackReads.get(key) ?? new Set<string>();
    if ([...pending].some((file) => !previous.has(file))) {
      const paths = [...previous, ...[...pending].filter((file) => !previous.has(file))].slice(-256);
      if (this.directory) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const destination = path.join(this.directory, `${key}.stack-reads.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify({ after: this.lastStackMove.get(key), paths }), { mode: 0o600, flag: "wx", flush: true });
          renameSync(temporary, destination);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      this.stackReads.set(key, new Set(paths));
    }
    this.pendingStackReads.delete(key);
  }

  readStackPaths(source: ThreadRef): string[] {
    this.load(source);
    const key = this.key(source);
    return [...new Set([...(this.stackReads.get(key) ?? []), ...(this.pendingStackReads.get(key) ?? [])])].slice(-256);
  }

  update(source: ThreadRef, id: string, status: Status, receipt = false): void {
    const records = this.load(source);
    const record = records.get(id);
    // A peer owns the recipient queue, not the sender's correspondence file.
    if (!record) return;
    // A cancellation or dispatch can beat the submission response back to the
    // sender. Its lifecycle evidence is newer than that response's queue state.
    if (receipt && record.state !== "sending") status = { ...status, state: record.state };
    this.append(source, { type: "status", id, status });
    records.set(id, { ...record, ...status });
  }

  cancelQueuedInput(
    source: ThreadRef,
    destination: ThreadRef,
    queueEntryId: string,
  ): CorrespondenceRecord[] {
    const records = [...this.load(source).values()].filter((candidate) =>
      candidate.queueEntryId === queueEntryId
      && candidate.destination.backend === destination.backend
      && candidate.destination.threadId === destination.threadId
      && candidate.destination.instanceId === destination.instanceId);
    return records.map((record) => {
      this.update(source, record.id, { state: "cancelled" });
      return { ...record, state: "cancelled" as const };
    });
  }

  message(source: ThreadRef, id: string): AppServerThreadMessageEntry | undefined {
    return this.appendToReplay(source, {
      entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
    }, id).entries[0] as AppServerThreadMessageEntry | undefined;
  }

  private pageRecords(
    key: string,
    stored: Map<string, CorrespondenceRecord>,
    turnIds: Iterable<string>,
    since: number,
    before: number,
    stackBefore: number,
  ): CorrespondenceRecord[] {
    let index = this.replayIndexes.get(key);
    if (!index) {
      index = { byTurn: new Map(), unbound: [], stackCompletions: [] };
      let order = 0;
      for (const record of stored.values()) {
        receiptBucket(index, record).push({ id: record.id, time: record.createdAt, order });
        order += 1;
      }
      index.unbound.sort(byReceiptTime);
      index.stackCompletions.sort(byReceiptTime);
      this.replayIndexes.set(key, index);
    }
    const positions = index.unbound.slice(timeBoundary(index.unbound, since), timeBoundary(index.unbound, before));
    const completions = index.stackCompletions;
    const completionEnd = timeBoundary(completions, stackBefore);
    for (let i = timeBoundary(completions, since); i < completionEnd; i += 1) {
      positions.push(completions[i]!);
    }
    for (const turnId of turnIds) {
      for (const position of index.byTurn.get(turnId) ?? []) positions.push(position);
    }
    return positions.sort(byReceiptTime).map(({ id }) => stored.get(id)!);
  }

  private replayMessage(source: ThreadRef, record: CorrespondenceRecord, turnId?: string): AppServerThreadMessageEntry {
    if (record.stackNotice) {
      const text = formatStackNotice(record.stackNotice);
      return {
        type: "message", id: record.id, role: "assistant", createdAt: record.createdAt,
        origin: { kind: "pwragent", systemReason: "stack-notice", stackNotice: record.stackNotice },
        text, parts: [{ type: "text", text }],
        ...(turnId ? { turn: { id: turnId } } : {}),
      };
    }
    const destination = buildThreadMarkdownLink({ ...record.destination, ...(record.turnId ? { messageId: `user:${record.turnId}` } : {}) });
    // The transcript collapses this message by parsing the heading back.
    const heading = buildThreadCorrespondenceHeading(destination, record.state);
    const body = record.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    const text = `${heading}\n\n${body}`;
    return {
      type: "message",
      id: record.id,
      role: "assistant",
      createdAt: record.createdAt,
      ...(turnId ? { turn: { id: turnId } } : {}),
      origin: { kind: "pwragent", systemReason: "thread-correspondence", sourceThread: { ...record.source, ...(source.title ? { title: source.title } : {}) } },
      text,
      parts: [
        { type: "text", text },
        ...record.input.flatMap((item) => {
          if (item.type === "localImage") return [{ type: "image" as const, url: toTranscriptImageProtocolUrl(pathToFileURL(item.path).toString()), alt: item.name }];
          if (item.type === "image") return [{ type: "image" as const, url: item.url, alt: item.name }];
          return [];
        }),
        ...record.input.flatMap((item) => item.type === "file" || item.type === "localFile"
          ? [{ type: "file" as const, name: item.name ?? (item.type === "file" ? "Attachment" : item.path) }]
          : []),
      ],
    };
  }

  appendToReplay(
    source: ThreadRef,
    replay: AppServerThreadReplay,
    onlyId?: string,
    knownTurns: AppServerThreadTurnMetadata[] = [],
    page: { before?: string; limit?: number } = {},
  ): AppServerThreadReplay {
    const empty = replay.entries.length === 0 && replay.messages.length === 0;
    if (!onlyId && (page.limit === 0 || (page.before !== undefined && empty))) return replay;
    const stored = this.load(source);
    const selected = onlyId ? stored.get(onlyId) : undefined;
    if (onlyId ? !selected : !stored.size) return replay;
    const providerEntries: AppServerThreadEntry[] = (replay.entries.length
      ? replay.entries
      : replay.messages.map((message) => ({ ...message, type: "message" as const })))
      .filter((entry) => !stored.has(entry.id));
    const sourceKey = this.key(source);
    const timing: TurnTimings = (onlyId ? undefined : this.turnTimings.get(sourceKey)) ?? { byId: new Map() };
    if (!onlyId) this.turnTimings.set(sourceKey, timing);
    const newTurns = new Map<string, AppServerThreadTurnMetadata>();
    const previousStarts = new Map<string, number | undefined>();
    const rememberTurnTiming = (turn: AppServerThreadTurnMetadata) => {
      const previous = timing.byId.get(turn.id);
      const startedAt = turn.startedAt ?? previous?.startedAt;
      const completedAt = turn.completedAt ?? previous?.completedAt;
      if (previous && previous.startedAt === startedAt && previous.completedAt === completedAt) return;
      if (previous) {
        if (previous.startedAt !== startedAt && !newTurns.has(turn.id) && !previousStarts.has(turn.id)) {
          previousStarts.set(turn.id, previous.startedAt);
        }
        previous.startedAt = startedAt;
        previous.completedAt = completedAt;
      } else {
        const observed = { id: turn.id, startedAt, completedAt };
        timing.byId.set(turn.id, observed);
        newTurns.set(turn.id, observed);
      }
    };
    for (const turn of knownTurns) rememberTurnTiming(turn);
    const indexesByTurn = new Map<string, number[]>();
    const indexesByItem = new Map<string, number>();
    providerEntries.forEach((entry, index) => {
      if (entry.turn) {
        rememberTurnTiming(entry.turn);
        const indexes = indexesByTurn.get(entry.turn.id) ?? [];
        indexes.push(index);
        indexesByTurn.set(entry.turn.id, indexes);
        indexesByItem.set(`${entry.turn.id}:${entry.id}`, index);
        if (entry.type === "activity") {
          for (const detail of entry.details) indexesByItem.set(`${entry.turn.id}:${detail.id}`, index);
        }
      }
    });
    const startedAt = (turn: AppServerThreadTurnMetadata) => turn.startedAt
      ?? (source.backend === "codex" ? readUuidV7Timestamp(turn.id) : undefined);
    const indexTurnStarts = (turns: AppServerThreadTurnMetadata[]) => turns.flatMap((turn) => {
      const start = startedAt(turn);
      return start === undefined ? [] : [{ id: turn.id, time: -start }];
    }).reverse().sort((left, right) => left.time - right.time);
    // Ledger hints and page rows can report different precision. Invalidate
    // only when the combined observation changes a previously indexed start.
    for (const [id, previous] of previousStarts) {
      if (timing.byId.get(id)?.startedAt !== previous) {
        timing.newestFirst = undefined;
        break;
      }
    }
    if (timing.newestFirst && newTurns.size) {
      const earlier = indexTurnStarts([...newTurns.values()]);
      const last = timing.newestFirst.at(-1)?.time ?? -Infinity;
      if (earlier[0] && earlier[0].time <= last) timing.newestFirst = undefined;
      else for (const turn of earlier) timing.newestFirst.push(turn);
    }
    const timedTurns = timing.newestFirst ??= indexTurnStarts([...timing.byId.values()]);
    const timestamp = (entry: AppServerThreadEntry) => entry.createdAt
      ?? (entry.turn ? startedAt(timing.byId.get(entry.turn.id) ?? entry.turn) : undefined);
    const insertions = new Map<number, AppServerThreadMessageEntry[]>();
    const cursors = new Map<string | undefined, number>();
    const allIndexes = providerEntries.map((_entry, index) => index);
    let firstPageTurn: number | undefined;
    let lastPageTurn: number | undefined;
    for (const id of indexesByTurn.keys()) {
      const time = startedAt(timing.byId.get(id)!);
      if (time === undefined) continue;
      firstPageTurn = Math.min(firstPageTurn ?? time, time);
      lastPageTurn = Math.max(lastPageTurn ?? time, time);
    }
    const next = lastPageTurn === undefined ? undefined : timedTurns[timeBoundary(timedTurns, -lastPageTurn) - 1];
    const nextPageTurn = next ? -next.time : undefined;
    const records = selected ? [selected] : indexesByTurn.size === 0
      ? [...stored.values()].sort((left, right) => left.createdAt - right.createdAt)
      : this.pageRecords(
        sourceKey, stored, indexesByTurn.keys(),
        (replay.pagination.hasPreviousPage ? firstPageTurn : undefined) ?? -Infinity,
        nextPageTurn ?? Infinity,
        page.before === undefined ? Infinity : nextPageTurn ?? -Infinity,
      );
    for (const record of records) {
      const completion = Boolean(record.stackNotice?.completion);
      if (!onlyId && completion) {
        if ((firstPageTurn !== undefined && record.createdAt < firstPageTurn && (replay.pagination.hasPreviousPage || page.before !== undefined))
          || (page.before !== undefined && (nextPageTurn === undefined || record.createdAt >= nextPageTurn))) continue;
      } else if (!onlyId && empty && replay.pagination.supportsPagination
        && (replay.pagination.hasPreviousPage || record.sourceTurnId)) {
        continue;
      }
      const turnIndex = record.sourceTurnId && !completion ? timedTurns.length : timeBoundary(timedTurns, -record.createdAt);
      const inferredTurn = completion ? undefined : timedTurns[turnIndex];
      const sourceTurnId = completion ? undefined : record.sourceTurnId ?? inferredTurn?.id;
      const turnIndexes = sourceTurnId ? indexesByTurn.get(sourceTurnId) : undefined;
      // A page owns its source turns. Never attach the thread's entire send
      // history to the newest page, where provider rows may have no dates.
      if (!onlyId && indexesByTurn.size > 0 && sourceTurnId && !turnIndexes) continue;
      if (!onlyId && replay.pagination.hasPreviousPage && turnIndex === timedTurns.length
        && !sourceTurnId && timedTurns.length > 0) continue;
      const completedAt = inferredTurn ? timing.byId.get(inferredTurn.id)?.completedAt : undefined;
      const sentAfterTurn = completedAt !== undefined && record.createdAt > completedAt;
      // Only the newest page has an open end. An older page may claim a send
      // after its final turn if the next known start bounds the idle interval.
      if (!onlyId && inferredTurn && page.before !== undefined && inferredTurn.time === timedTurns[0]?.time
        && (sentAfterTurn || completedAt === undefined)) continue;
      const itemIndex = sourceTurnId && record.sourceItemId
        ? indexesByItem.get(`${sourceTurnId}:${record.sourceItemId}`) : undefined;
      let position: number;
      if (sentAfterTurn && turnIndexes) {
        position = turnIndexes.at(-1)! + 1;
      } else if (itemIndex !== undefined) {
        position = itemIndex + 1;
      } else {
        const indexes = turnIndexes ?? allIndexes;
        let cursor = cursors.get(sourceTurnId) ?? 0;
        while (cursor < indexes.length) {
          const entry = providerEntries[indexes[cursor]!]!;
          const time = timestamp(entry);
          if (time !== undefined && time > record.createdAt) break;
          // A turn total follows all its messages, including undated sends.
          if (turnIndexes && isUsageActivityEntry(entry) && usageActivityScope(entry) === "turn") break;
          cursor += 1;
        }
        cursors.set(sourceTurnId, cursor);
        position = indexes[cursor] ?? (indexes.length ? indexes[indexes.length - 1]! + 1 : providerEntries.length);
      }
      const bucket = insertions.get(position) ?? [];
      // The preceding turn owns the idle interval for pagination, while the
      // receipt itself stays outside that turn (including its usage total).
      bucket.push(this.replayMessage(source, record, sentAfterTurn ? undefined : sourceTurnId));
      insertions.set(position, bucket);
    }
    const entries: AppServerThreadEntry[] = [];
    providerEntries.forEach((entry, index) => entries.push(...(insertions.get(index) ?? []), entry));
    entries.push(...(insertions.get(providerEntries.length) ?? []));

    // Derive compact-message anchors from the timeline merge, since that
    // list omits both activity rows and the source turn metadata.
    const providerMessages = replay.messages.filter((message) => !stored.has(message.id));
    const providerMessageIds = new Set(providerMessages.map((message) => message.id));
    const messagesBefore = new Map<string | undefined, AppServerThreadMessageEntry[]>();
    let nextMessageId: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (providerMessageIds.has(entry.id)) nextMessageId = entry.id;
      else if (stored.has(entry.id) && entry.type === "message") {
        const bucket = messagesBefore.get(nextMessageId) ?? [];
        bucket.push(entry);
        messagesBefore.set(nextMessageId, bucket);
      }
    }
    const compactMessages: AppServerThreadMessage[] = [];
    for (const message of providerMessages) compactMessages.push(...(messagesBefore.get(message.id) ?? []).reverse(), message);
    compactMessages.push(...(messagesBefore.get(undefined) ?? []).reverse());
    return { ...replay, entries, messages: compactMessages };
  }
}
