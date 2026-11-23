import type { DecisionImageMimeType } from "./decision-models";

/**
 * What the thread's Decisions tab shows: the decisions visible to the
 * thread and the decisions_invoke batches it ran. The owner builds these
 * from its decision registry, its in-memory batches, and each batch's
 * JSONL result file; nothing here is read from or written to SQLite
 * beyond the registry itself.
 */

export type DecisionsRailProvider = "openai" | "jev" | "local";

export type DecisionsRailQuestion = {
  type: "predicate" | "choice" | "score";
  name?: string;
  /** A choice question's values. */
  choices?: string[];
  /** A score question's level labels. */
  levels?: string[];
};

/** One question as a batch asked it: what it asks and the answers it allows. */
export type DecisionsRailDefinitionQuestion = {
  type: "predicate" | "choice" | "score";
  name?: string;
  instructions: string;
  /** A choice question's values, or a score question's level labels, in order. */
  options?: Array<{ label: string; description?: string }>;
};

/**
 * The prompt every item of a batch shared: its questions and the cached
 * prefix. Kept in the batch's result file, so an ad hoc definition, which
 * is never stored, still reads back.
 */
export type DecisionsRailDefinition = {
  questions: DecisionsRailDefinitionQuestion[];
  prefix?: string;
};

/** Per-request time for one decision version, from requests since PwrAgent started. */
export type DecisionsRailTiming = {
  samples: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
};

export type DecisionsRailDecision = {
  decisionId: string;
  name: string;
  version: number;
  scope: "profile" | "thread";
  provider: DecisionsRailProvider;
  /** The provider is turned off in Settings → AI Providers. */
  providerDisabled: boolean;
  questions: DecisionsRailQuestion[];
  inputSchema: Record<string, unknown>;
  timing?: DecisionsRailTiming;
};

export type DecisionsRailBatchState = "queued" | "running" | "completed" | "stopped" | "cancelled";

export type DecisionsRailBatch = {
  batchId: string;
  decisionId: string;
  name: string;
  version: number;
  /** Ran from a decisions_invoke definition that was never stored; its name and version are placeholders. */
  adHoc: boolean;
  /** Each question's name, or its type when it has none. Absent for batches written before definitions were kept. */
  questionNames?: string[];
  provider: DecisionsRailProvider;
  /** The model the provider reported for the batch's first answered item. */
  model?: string;
  state: DecisionsRailBatchState;
  /** Stop was pressed: no item starts, and the ones in flight are finishing. */
  stopping: boolean;
  background: boolean;
  count: number;
  /** Items with an outcome: succeeded plus failed. Skipped items count as failed. */
  finished: number;
  succeeded: number;
  /** Failed items that ran, skipped ones excluded. */
  failed: number;
  skipped: number;
  concurrency: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** From start to finish, or to the snapshot while it runs. */
  wallMs?: number;
  /** Items that ran (not skipped) per second of wall time. */
  itemsPerSecond?: number;
  /** Over succeeded items that recorded a duration. */
  latency?: { samples: number; meanMs: number; maxMs: number };
  stoppedBy?: { code: string; message: string };
  cancelReason?: string;
  /** The batch has a result file the operator can open. */
  hasResultsFile: boolean;
};

export type DecisionsRailSnapshot = {
  decisions: DecisionsRailDecision[];
  /** Newest first. */
  batches: DecisionsRailBatch[];
  /** The owner's clock when the snapshot was taken. */
  now: number;
};

/**
 * The strip above the composer: the thread's batches that are running or
 * waiting, and those an error stopped, until the operator dismisses them.
 * Read from owner memory only.
 */
export type DecisionsRailActiveBatches = {
  batches: DecisionsRailBatch[];
  now: number;
};

export type DecisionsRailAnswer = {
  name?: string;
  type: "predicate" | "choice" | "score" | "refusal" | "unavailable" | "other";
  /** What the model answered: yes, no, a choice value, or a score. */
  value?: string;
  /** How likely the shown value is, from 0 to 1. */
  probability?: number;
  /** Why an unavailable answer has no value. */
  reason?: string;
};

export const DECISION_IMAGE_THUMBNAIL_MAX_LENGTH = 16 * 1024;

export type DecisionsRailInputImage = {
  mimeType: DecisionImageMimeType;
  width: number;
  height: number;
  /** A bounded, re-encoded JPEG data URL with metadata removed. */
  thumbnail?: string;
};

export type DecisionsRailItem = {
  index: number;
  ok: boolean;
  answers?: DecisionsRailAnswer[];
  /** The input's compact JSON, cut to about 2 KB. Absent for batches written before previews. */
  inputPreview?: string;
  inputTruncated?: boolean;
  /** The input looked like it held a credential, so no preview was kept. */
  inputRedacted?: boolean;
  inputImages?: DecisionsRailInputImage[];
  durationMs?: number;
  code?: string;
  message?: string;
};

export type DecisionsRailItemFilter = "all" | "succeeded" | "failed" | "skipped";

export type DecisionsRailThreadRequest = { backend: string; threadId: string };

export type DecisionsRailBatchRequest = DecisionsRailThreadRequest & {
  batchId: string;
  status: DecisionsRailItemFilter;
  from: number;
  limit: number;
};

export type DecisionsRailBatchPage = {
  batch: DecisionsRailBatch;
  /** Absent for batches written before definitions were kept. */
  definition?: DecisionsRailDefinition;
  items: DecisionsRailItem[];
  /** Pass back as `from` for the items after these; absent when none follow yet. */
  nextFrom?: number;
};

export type DecisionsRailBatchActionRequest = DecisionsRailThreadRequest & {
  batchId: string;
  /** Stop lets requests in flight finish; Cancel aborts them too. */
  action: "stop" | "cancel";
};

export type DecisionsRailBatchActionResult = { outcome: "stopped" | "cancelled" | "not_running" };

export type DecisionsRailOpenResultsRequest = DecisionsRailThreadRequest & { batchId: string };

export type DecisionsRailOpenResultsResult = { opened: boolean; error?: string };

/**
 * Settings → AI Providers → Decisions: the profile's own decisions. They
 * outlive any one thread, so the operator sees and deletes them here
 * rather than only from a thread's rail.
 */
export type DecisionsProfileDecision = DecisionsRailDecision & {
  /** When this version was registered. */
  createdAt: number;
};

export type DecisionsProfileList = { decisions: DecisionsProfileDecision[] };

export type DecisionsProfileDeleteRequest = { decisionId: string };

/** "not_found": no profile decision with that id is active, such as one an agent deleted first. */
export type DecisionsProfileDeleteResult = { outcome: "deleted" | "not_found" };

/** stoppedBy.code of a batch the operator stopped from the thread, as opposed to one an error stopped. */
export const DECISIONS_OPERATOR_STOP_CODE = "stopped_by_operator";

/** Items in one Decisions tab page. */
export const DECISIONS_RAIL_PAGE_MAX_ITEMS = 500;
