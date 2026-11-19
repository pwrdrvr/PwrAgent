import type {
  ResearchEvent, ResearchRun, ResearchThread, ResearchRunHeader, ResearchItem, ResearchSearchQuery, ResearchSearchPage, ResearchRunSummary,
  ResearchEventRange, ResearchEventPage, ResearchApproach, ResearchDelivery, ResearchBoardRange, ResearchBoardPage,
  ResearchChangesCursor, ResearchChangePage, ResearchSubmission, ResearchProfileRunsQuery, ResearchProfileRun, ResearchRunAttention,
} from "@pwragent/shared/research";

/**
 * The journal is the source of truth. Every other read is a projection that
 * `create` and `append` write in the same commit as the event, so a read costs
 * what it returns, not the run's history. Reads never repair or write.
 */
export interface ResearchStorage {
  /** Replays the whole journal. For recovery and tests only: no command, observer or view reads this way. */
  get(id: string): ResearchRun | undefined;
  runIdForStartKey(key: string): string | undefined;
  header(id: string): ResearchRunHeader | undefined;
  /** Running and stopping runs, newest first: all of them, or those the thread belongs to. */
  activeRuns(thread?: ResearchThread): ResearchRunHeader[];
  summaries(thread: ResearchThread): ResearchRunHeader[];
  /** The thread's newest runs, or only `runId` when the thread belongs to it. */
  runSummaries(thread: ResearchThread, limit: number, runId?: string): ResearchRunSummary[];
  /**
   * One page of every run on the profile, by attention group and then newest first, with each group's
   * total under the same filters. One snapshot; no journal replay.
   */
  profileRuns(query: ResearchProfileRunsQuery, limit: number): { runs: Array<Omit<ResearchProfileRun, "thread">>; counts: Record<ResearchRunAttention, number> };
  /** One page of the journal and its revision, read from one snapshot. */
  events(id: string, range: ResearchEventRange): ResearchEventPage;
  members(id: string): ResearchThread[];
  /** The coordinator, or any thread a worker event has named. */
  isMember(id: string, thread: ResearchThread): boolean;
  /** True while an approach of the run names the thread as its worker. */
  isApproachWorker(id: string, thread: ResearchThread): boolean;
  /** True while an approach of any running or stopping run names the thread as its worker. */
  isActiveWorker(thread: ResearchThread): boolean;
  readItem(id: string, itemId: string): ResearchItem | undefined;
  /** Approaches in creation order: those the thread works on, or those holding a worker slot. */
  approaches(id: string, filter: { worker: ResearchThread } | { occupying: true } | { interrupted: true }): ResearchApproach[];
  /** Items whose work is assigned, claimed, in progress or blocked, in creation order. */
  underwayItems(id: string): ResearchItem[];
  /** Whether the run has a submission, or one with this review decision. */
  hasSubmission(id: string, decision?: NonNullable<ResearchSubmission["review"]>["decision"]): boolean;
  delivery(id: string, deliveryId: string): ResearchDelivery | undefined;
  /** Deliveries in creation order: those not yet cancelled or ended, or those with this queue entry. */
  deliveries(id: string, filter: { open: true } | { queueEntryId: string }): ResearchDelivery[];
  /** One page of each list the agent tools read, from one snapshot. */
  board(id: string, range: ResearchBoardRange): ResearchBoardPage | undefined;
  /** Items changed after `sinceRevision`, with the run's state, from one snapshot. */
  changes(id: string, sinceRevision?: number, after?: ResearchChangesCursor, limit?: number): ResearchChangePage | undefined;
  search(id: string, query: ResearchSearchQuery): ResearchSearchPage;
  findCommand(id: string, commandId: string): ResearchEvent | undefined;
  /** The immutable receipt of one source record, read by its source sequence. */
  harnessRecord(id: string, seq: number): ResearchEvent | undefined;
  create(id: string, startKey: string, event: ResearchEvent): void;
  /** Compare-and-append atomically. False when the command was already recorded; a conflicting duplicate is refused. */
  append(id: string, revision: number, event: ResearchEvent): boolean;
  /** A bounded service-record page and its cursor commit together. */
  appendBatch(id: string, revision: number, events: ResearchEvent[]): void;
}
