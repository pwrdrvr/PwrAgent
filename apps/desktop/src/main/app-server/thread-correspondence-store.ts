import { pathToFileURL } from "node:url";
import { toTranscriptImageProtocolUrl } from "../transcript-image-protocol";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerThreadMessage,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadReplay,
  AppServerThreadTurnMetadata,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import { buildThreadMarkdownLink } from "@pwragent/shared";
import { isUsageActivityEntry, usageActivityScope } from "./overlay-transcript-entries";

type ThreadRef = { backend: AppServerBackendKind; threadId: string; instanceId?: string; title?: string };
export type CorrespondenceRecord = {
  id: string;
  source: ThreadRef;
  destination: ThreadRef;
  input: AppServerTurnInputItem[];
  createdAt: number;
  state: "sending" | "queued" | "started" | "failed" | "cancelled" | "held";
  queueEntryId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceItemId?: string;
};
type Status = Pick<CorrespondenceRecord, "state"> & Partial<Pick<CorrespondenceRecord, "destination" | "queueEntryId" | "turnId">>;
type Event = { type: "message"; record: CorrespondenceRecord } | { type: "status"; id: string; status: Status };

function codexTurnStartedAt(id: string): number | undefined {
  // Only UUIDv7 encodes a creation time. Arbitrary provider ids are opaque.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return undefined;
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/** PwrAgent-owned supplemental correspondence, never provider history or SQLite. */
export class ThreadCorrespondenceStore {
  private readonly records = new Map<string, Map<string, CorrespondenceRecord>>();
  // Retain only turn timing metadata across page reads, never transcript rows.
  // A newer page's turn start bounds the last turn of the next older page.
  private readonly turnTimings = new Map<string, Map<string, AppServerThreadTurnMetadata>>();
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
        let event: Event;
        try { event = JSON.parse(line) as Event; }
        catch { throw new Error(`Invalid PwrAgent correspondence record at ${file}:${index + 1}`); }
        if (event.type === "message") records.set(event.record.id, event.record);
        else if (event.type === "status") {
          const record = records.get(event.id);
          if (record) records.set(event.id, { ...record, ...event.status });
        } else throw new Error(`Invalid PwrAgent correspondence event at ${file}:${index + 1}`);
      }
    }
    this.records.set(key, records);
    return records;
  }

  private append(source: ThreadRef, event: Event): void {
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(this.directory, `${this.key(source)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  record(record: CorrespondenceRecord): void {
    const records = this.load(record.source);
    this.append(record.source, { type: "message", record });
    records.set(record.id, structuredClone(record));
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

  replaceQueuedInput(
    source: ThreadRef,
    destination: ThreadRef,
    queueEntryId: string,
    input: AppServerTurnInputItem[],
  ): CorrespondenceRecord | undefined {
    const record = [...this.load(source).values()].find((candidate) =>
      candidate.queueEntryId === queueEntryId
      && candidate.destination.backend === destination.backend
      && candidate.destination.threadId === destination.threadId
      && candidate.destination.instanceId === destination.instanceId);
    if (!record) return undefined;
    const updated = { ...record, input };
    this.record(updated);
    return updated;
  }

  message(source: ThreadRef, id: string): AppServerThreadMessageEntry | undefined {
    return this.appendToReplay(source, {
      entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
    }, id).entries[0] as AppServerThreadMessageEntry | undefined;
  }

  appendToReplay(
    source: ThreadRef,
    replay: AppServerThreadReplay,
    onlyId?: string,
    knownTurns: AppServerThreadTurnMetadata[] = [],
    page: { before?: string; limit?: number } = {},
  ): AppServerThreadReplay {
    if (!onlyId && (page.limit === 0
      || (replay.entries.length === 0 && replay.messages.length === 0
        && (replay.pagination.supportsPagination || page.before !== undefined)))) return replay;
    const stored = this.load(source);
    const selected = onlyId ? stored.get(onlyId) : undefined;
    const records = onlyId ? (selected ? [selected] : []) : [...stored.values()];
    if (records.length === 0) return replay;
    records.sort((left, right) => left.createdAt - right.createdAt);
    const messages: AppServerThreadMessageEntry[] = records.map((record) => {
      const destination = buildThreadMarkdownLink({ ...record.destination, ...(record.turnId ? { messageId: `user:${record.turnId}` } : {}) });
      const state = {
        sending: "Send outcome unknown",
        queued: "Queued (last confirmed)",
        started: "Receiving thread started work",
        failed: "Failed to send",
        cancelled: "Cancelled",
        held: "Held for retry",
      }[record.state];
      const heading = `**Message to ${destination}** · ${state}`;
      const body = record.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return {
        type: "message",
        id: record.id,
        role: "assistant",
        createdAt: record.createdAt,
        ...(record.sourceTurnId ? { turn: { id: record.sourceTurnId } } : {}),
        origin: { kind: "pwragent", systemReason: "thread-correspondence" },
        text: `${heading}\n\n${body}`,
        parts: [
          { type: "text", text: `${heading}\n\n${body}` },
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
    });
    const storedIds = new Set(stored.keys());
    const providerEntries: AppServerThreadEntry[] = (replay.entries.length
      ? replay.entries
      : replay.messages.map((message) => ({ ...message, type: "message" as const })))
      .filter((entry) => !storedIds.has(entry.id));
    const sourceKey = this.key(source);
    const turns = onlyId ? new Map<string, AppServerThreadTurnMetadata>()
      : this.turnTimings.get(sourceKey) ?? new Map<string, AppServerThreadTurnMetadata>();
    if (!onlyId) this.turnTimings.set(sourceKey, turns);
    for (const turn of knownTurns) {
      const previous = turns.get(turn.id);
      turns.set(turn.id, {
        ...previous, ...turn,
        startedAt: turn.startedAt ?? previous?.startedAt,
        completedAt: turn.completedAt ?? previous?.completedAt,
      });
    }
    const indexesByTurn = new Map<string, number[]>();
    const indexesByItem = new Map<string, number>();
    providerEntries.forEach((entry, index) => {
      if (entry.turn) {
        const previous = turns.get(entry.turn.id);
        turns.set(entry.turn.id, {
          ...previous, ...entry.turn,
          startedAt: entry.turn.startedAt ?? previous?.startedAt,
          completedAt: entry.turn.completedAt ?? previous?.completedAt,
        });
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
      ?? (source.backend === "codex" ? codexTurnStartedAt(turn.id) : undefined);
    const timedTurns = [...turns.values()].flatMap((turn) => {
      const time = startedAt(turn);
      return time === undefined ? [] : [{ id: turn.id, time, completedAt: turn.completedAt }];
    }).sort((left, right) => left.time - right.time);
    const timestamp = (entry: AppServerThreadEntry) => entry.createdAt
      ?? (entry.turn ? startedAt(turns.get(entry.turn.id) ?? entry.turn) : undefined);
    const insertions = new Map<number, AppServerThreadMessageEntry[]>();
    const cursors = new Map<string | undefined, number>();
    const allIndexes = providerEntries.map((_entry, index) => index);
    let turnIndex = -1;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const message = messages[index]!;
      while (turnIndex + 1 < timedTurns.length && timedTurns[turnIndex + 1]!.time <= record.createdAt) turnIndex += 1;
      const sourceTurnId = record.sourceTurnId ?? timedTurns[turnIndex]?.id;
      const turnIndexes = sourceTurnId ? indexesByTurn.get(sourceTurnId) : undefined;
      // A page owns its source turns. Never attach the thread's entire send
      // history to the newest page, where provider rows may have no dates.
      if (!onlyId && indexesByTurn.size > 0 && sourceTurnId && !turnIndexes) continue;
      if (!onlyId && replay.pagination.hasPreviousPage && turnIndex < 0 && !sourceTurnId && timedTurns.length > 0) continue;
      if (!onlyId && !record.sourceTurnId && sourceTurnId) {
        const inferredTurn = timedTurns[turnIndex]!;
        if (inferredTurn.completedAt !== undefined && record.createdAt > inferredTurn.completedAt) continue;
        // An older page's final turn cannot own arbitrary later receipts.
        // Without a completion time or a newer turn boundary, leave legacy
        // ownership unresolved rather than duplicate newer message bodies.
        if (page.before !== undefined && turnIndex === timedTurns.length - 1
          && inferredTurn.completedAt === undefined) continue;
      }
      if (sourceTurnId) message.turn = { id: sourceTurnId };
      const itemIndex = sourceTurnId && record.sourceItemId
        ? indexesByItem.get(`${sourceTurnId}:${record.sourceItemId}`) : undefined;
      let position: number;
      if (itemIndex !== undefined) {
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
      bucket.push(message);
      insertions.set(position, bucket);
    }
    const entries: AppServerThreadEntry[] = [];
    providerEntries.forEach((entry, index) => entries.push(...(insertions.get(index) ?? []), entry));
    entries.push(...(insertions.get(providerEntries.length) ?? []));

    // Derive compact-message anchors from the timeline merge, since that
    // list omits both activity rows and the source turn metadata.
    const providerMessages = replay.messages.filter((message) => !storedIds.has(message.id));
    const providerMessageIds = new Set(providerMessages.map((message) => message.id));
    const messagesBefore = new Map<string | undefined, AppServerThreadMessageEntry[]>();
    let nextMessageId: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (providerMessageIds.has(entry.id)) nextMessageId = entry.id;
      else if (storedIds.has(entry.id) && entry.type === "message") {
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
