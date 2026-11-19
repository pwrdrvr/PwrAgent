import {
  projectResearchRun, researchApproachOccupiesSlot, researchBoardPage, researchChangePage, researchEventPage, sameResearchThread, searchResearchItems, summarizeResearchRun,
  researchRunAttention, RESEARCH_RUN_ATTENTION_ORDER, type ResearchProfileRunsQuery, type ResearchRunAttention,
  type ResearchApproach, type ResearchBoardRange, type ResearchChangesCursor, type ResearchEvent, type ResearchEventRange, type ResearchRun, type ResearchRunHeader,
  type ResearchSearchQuery, type ResearchSubmission, type ResearchThread,
} from "@pwragent/shared/research";
import type { ResearchStorage } from "../../research-storage";

const replayed = new WeakMap<ResearchEvent[], ResearchRun>();

/** Reuse a frozen snapshot until its append-only journal grows. */
export function replayResearchJournal(id: string, records: ResearchEvent[] | undefined): ResearchRun | undefined {
  if (!records) return undefined;
  const held = replayed.get(records);
  if (held?.id === id && held.revision === records.length) return held;
  const run = deepFreeze(projectResearchRun(id, structuredClone(records)));
  replayed.set(records, run);
  return run;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Journals in memory. Reads answer from `projectResearchRun` at the current
 * revision, so this storage is the oracle for what a stored
 * projection must return. Membership follows the SQLite store: the
 * coordinator, or any thread a worker event has named.
 */
export class MemoryResearchStorage implements ResearchStorage {
  readonly records = new Map<string, ResearchEvent[]>();
  readonly keys = new Map<string, string>();
  readonly workers = new Map<string, ResearchThread[]>();

  get(id: string): ResearchRun | undefined {
    return replayResearchJournal(id, this.records.get(id));
  }
  /** Every run, replayed, newest first as the SQLite store orders them. */
  all(): ResearchRun[] {
    return [...this.records.keys()].map((id) => this.get(id)!).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
  runIdForStartKey(key: string) { return this.keys.get(key); }
  header(id: string): ResearchRunHeader | undefined {
    const run = this.get(id);
    if (!run) return undefined;
    const { unreviewed: _unreviewed, accepted: _accepted, harness: _harness, ...header } = summarizeResearchRun(run);
    return { ...header, ...(run.harness ? { harness: run.harness } : {}) };
  }
  activeRuns(thread?: ResearchThread) {
    return this.all().filter((run) => ["running", "stopping"].includes(run.status) && (!thread || this.isMember(run.id, thread))).map((run) => this.header(run.id)!);
  }
  summaries(thread: ResearchThread) { return this.all().filter((run) => this.isMember(run.id, thread)).slice(0, 20).map((run) => this.header(run.id)!); }
  /** The oracle for the store's ranked run list: the shared attention rule over replayed runs. */
  profileRuns(query: ResearchProfileRunsQuery, limit: number) {
    const text = query.text?.trim().toLowerCase();
    const rank = (attention: ResearchRunAttention) => RESEARCH_RUN_ATTENTION_ORDER.indexOf(attention);
    const all = this.all().map((run) => { const summary = summarizeResearchRun(run); return { ...summary, attention: researchRunAttention(summary) }; })
      .filter((run) => (!query.source || (query.source === "harness") === Boolean(run.harness)) && (!text || run.objective.toLowerCase().includes(text)))
      .sort((a, b) => rank(a.attention) - rank(b.attention) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const counts: Record<ResearchRunAttention, number> = { needs_you: 0, live: 0, retained: 0 };
    for (const run of all) counts[run.attention]++;
    const after = query.after;
    const rest = after ? all.filter((run) => rank(run.attention) > rank(after.attention)
      || (run.attention === after.attention && (run.createdAt < after.createdAt || (run.createdAt === after.createdAt && run.id < after.id)))) : all;
    return { runs: rest.slice(0, limit), counts };
  }
  runSummaries(thread: ResearchThread, limit: number, runId?: string) {
    return this.all().filter((run) => this.isMember(run.id, thread) && (runId === undefined || run.id === runId)).slice(0, limit).map(summarizeResearchRun);
  }
  events(id: string, range: ResearchEventRange) {
    const run = this.get(id);
    if (!run) throw new Error("Research run not found");
    return researchEventPage(run, range);
  }
  members(id: string) { return [this.get(id)!.coordinator, ...(this.workers.get(id) ?? [])]; }
  isMember(id: string, thread: ResearchThread) {
    const run = this.get(id);
    return Boolean(run && (sameResearchThread(run.coordinator, thread) || (this.workers.get(id) ?? []).some((worker) => sameResearchThread(worker, thread))));
  }
  isApproachWorker(id: string, thread: ResearchThread) {
    return Boolean(this.get(id)?.approaches.some((approach) => approach.worker && sameResearchThread(approach.worker, thread)));
  }
  isActiveWorker(thread: ResearchThread) {
    return this.all().some((run) => ["running", "stopping"].includes(run.status) && run.approaches.some((approach) => approach.worker && sameResearchThread(approach.worker, thread)));
  }
  readItem(id: string, itemId: string) { return this.get(id)?.items.find((item) => item.id === itemId); }
  approaches(id: string, filter: { worker: ResearchThread } | { occupying: true }): ResearchApproach[] {
    const approaches = this.get(id)?.approaches ?? [];
    return "worker" in filter ? approaches.filter((approach) => approach.worker && sameResearchThread(approach.worker, filter.worker)) : approaches.filter(researchApproachOccupiesSlot);
  }
  underwayItems(id: string) { return (this.get(id)?.items ?? []).filter((item) => ["assigned", "claimed", "in_progress", "blocked"].includes(item.work.state)); }
  hasSubmission(id: string, decision?: NonNullable<ResearchSubmission["review"]>["decision"]) {
    return Boolean(this.get(id)?.submissions.some((submission) => decision === undefined || submission.review?.decision === decision));
  }
  delivery(id: string, deliveryId: string) { return this.get(id)?.deliveries.find((delivery) => delivery.id === deliveryId); }
  deliveries(id: string, filter: { open: true } | { queueEntryId: string }) {
    const deliveries = this.get(id)?.deliveries ?? [];
    return "queueEntryId" in filter ? deliveries.filter((delivery) => delivery.queueEntryId === filter.queueEntryId)
      : deliveries.filter((delivery) => !["cancelled", "ended"].includes(delivery.state));
  }
  board(id: string, range: ResearchBoardRange) { const run = this.get(id); return run ? researchBoardPage(run, range) : undefined; }
  changes(id: string, sinceRevision?: number, after?: ResearchChangesCursor, limit?: number) {
    const run = this.get(id);
    return run ? researchChangePage(run, sinceRevision, after, limit) : undefined;
  }
  search(id: string, query: ResearchSearchQuery) { const run = this.get(id)!; return searchResearchItems(id, run.items, run.revision, query); }
  findCommand(id: string, commandId: string) { return this.records.get(id)?.find((event) => event.commandId === commandId); }
  harnessRecord(id: string, seq: number) { return this.records.get(id)?.find((event) => event.data.type === "harness_observation" && event.provenance?.seq === seq); }
  create(id: string, key: string, event: ResearchEvent) {
    if (this.keys.has(key)) throw new Error("duplicate start");
    this.keys.set(key, id);
    this.records.set(id, [structuredClone(event)]);
  }
  append(id: string, revision: number, event: ResearchEvent) {
    const records = this.records.get(id)!;
    const prior = records.find((entry) => entry.commandId === event.commandId);
    if (prior) {
      if (prior.signature !== event.signature || JSON.stringify(prior.actor) !== JSON.stringify(event.actor)) throw new Error("Research command key was reused");
      return false;
    }
    if (records.length !== revision || event.seq !== revision + 1) throw new Error("Research run changed; read its current state before retrying");
    records.push(structuredClone(event));
    if (event.data.type === "worker" && event.data.worker) {
      const worker = { backend: event.data.worker.backend, threadId: event.data.worker.threadId };
      const known = this.workers.get(id) ?? [];
      if (!known.some((entry) => sameResearchThread(entry, worker))) this.workers.set(id, [...known, worker]);
    }
    return true;
  }
  appendBatch(id: string, revision: number, events: ResearchEvent[]): void {
    for (const event of events) this.append(id, revision++, event);
  }
}
