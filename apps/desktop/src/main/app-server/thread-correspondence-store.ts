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
  AppServerTurnInputItem,
} from "@pwragent/shared";
import { buildThreadMarkdownLink } from "@pwragent/shared";

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
};
type Status = Pick<CorrespondenceRecord, "state"> & Partial<Pick<CorrespondenceRecord, "destination" | "queueEntryId" | "turnId">>;
type Event = { type: "message"; record: CorrespondenceRecord } | { type: "status"; id: string; status: Status };

/** Keep provider order, including undated activities; insert before the next
 * strictly newer timestamp. Ties retain provider order before correspondence. */
function mergeCorrespondence<T extends { id: string }>(
  entries: T[],
  messages: AppServerThreadMessageEntry[],
  timestamp: (entry: T) => number | undefined,
): (T | AppServerThreadMessageEntry)[] {
  const ids = new Set(messages.map((message) => message.id));
  const merged: (T | AppServerThreadMessageEntry)[] = [];
  let index = 0;
  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    const createdAt = timestamp(entry);
    while (index < messages.length && createdAt !== undefined && messages[index]!.createdAt! < createdAt) {
      merged.push(messages[index++]!);
    }
    merged.push(entry);
  }
  merged.push(...messages.slice(index));
  return merged;
}

/** PwrAgent-owned supplemental correspondence, never provider history or SQLite. */
export class ThreadCorrespondenceStore {
  private readonly records = new Map<string, Map<string, CorrespondenceRecord>>();
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

  appendToReplay(source: ThreadRef, replay: AppServerThreadReplay, onlyId?: string): AppServerThreadReplay {
    const stored = this.load(source);
    const selected = onlyId ? stored.get(onlyId) : undefined;
    const records = onlyId ? (selected ? [selected] : []) : [...stored.values()];
    records.sort((left, right) => left.createdAt - right.createdAt);
    const messages: AppServerThreadMessageEntry[] = records.map((record) => {
      const destination = buildThreadMarkdownLink({ ...record.destination, ...(record.turnId ? { messageId: `user:${record.turnId}` } : {}) });
      const state = {
        sending: "Send outcome unknown",
        queued: "Queued (last confirmed)",
        started: "Accepted for execution",
        failed: "Failed to send",
        cancelled: "Cancelled",
        held: "Held for retry",
      }[record.state];
      const heading = `**${state}** · To ${destination}`;
      const body = record.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return {
        type: "message",
        id: record.id,
        role: "assistant",
        createdAt: record.createdAt,
        origin: { kind: "pwragent" },
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
    const timestamp = (entry: AppServerThreadEntry) => entry.createdAt ?? entry.turn?.startedAt;
    // The compact message list omits turn metadata; use the corresponding
    // replay entry's timestamp so both views place messages consistently.
    const entryTimestamps = new Map(replay.entries.map((entry) => [entry.id, timestamp(entry)]));
    return {
      ...replay,
      entries: mergeCorrespondence(replay.entries, messages, timestamp),
      messages: mergeCorrespondence<AppServerThreadMessage>(replay.messages, messages,
        (message) => message.createdAt ?? entryTimestamps.get(message.id)),
    };
  }
}
