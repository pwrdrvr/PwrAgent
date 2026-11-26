import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { ThreadLaunchedThread } from "@pwragent/shared/contracts/navigation";
import type {
  AppServerBackendKind,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  THREAD_TODO_BUSY_RETRY_MS,
  threadTodoSteps,
  type ListThreadTodosRequest,
  type ListThreadTodosResponse,
  type ThreadTodo,
  type ThreadTodoItem,
  type ThreadTodoStartedThread,
  type ThreadTodosChangedEvent,
} from "@pwragent/shared/contracts/thread-todos";
import { isNavigationBusy } from "../../../../shared/navigation-ipc-result";
import { formatBackendLabel } from "../../lib/backend-label";
import { insertSyntheticEntriesByTime } from "./synthetic-transcript-entries";

/**
 * Synthetic activity entries built from completed handoff to-dos that started
 * a thread. They stay at top level in the transcript (never folded into a
 * turn's work group) so launching a to-do card always leaves durable evidence
 * and a live ThreadChip in the transcript.
 */
export const LAUNCHED_TODO_ENTRY_PREFIX = "launched-todo:";

export type LaunchedTodo = ThreadTodo & {
  status: "done";
  startedThread: ThreadTodoStartedThread;
};

export type LaunchedTodoThreadScope = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
};

export type LaunchedTodoLinkRef = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
  instanceLabel?: string;
  fallbackLabel: string;
};

export type LaunchedTodoPresentation = {
  ariaLabel: string;
  copyText: string;
  detail?: string;
  facts: string[];
  hasExpandableBody: boolean;
  launchedAt: number;
  linkRef: LaunchedTodoLinkRef;
  prompt?: string;
  resultNotice?: string;
  setupFailure?: string;
  statusChipLabel?: string;
  steps: ThreadTodoItem[];
  title: string;
  turnStartFailure?: string;
  verb: string;
};

export type LaunchedThreadRecord =
  | {
      kind: "todo";
      id: string;
      launchedAt: number;
      createdAt: number;
      todo: LaunchedTodo;
    }
  | {
      kind: "tool";
      id: string;
      launchedAt: number;
      createdAt: number;
      launch: ThreadLaunchedThread;
      ownerInstanceId?: string;
    };

export function isLaunchedTodo(todo: ThreadTodo): todo is LaunchedTodo {
  if (todo.status !== "done" || !todo.startedThread) {
    return false;
  }
  const backend = todo.startedThread.backend;
  const threadId = todo.startedThread.threadId;
  return (
    typeof backend === "string"
    && backend.trim().length > 0
    && typeof threadId === "string"
    && threadId.trim().length > 0
  );
}

/**
 * The moment the card launched its thread: `resolvedAt` when recorded,
 * falling back to `updatedAt`, then `createdAt`.
 */
export function launchedTodoTimestamp(
  todo: Pick<ThreadTodo, "createdAt" | "updatedAt" | "resolvedAt">,
): number {
  if (typeof todo.resolvedAt === "number" && Number.isFinite(todo.resolvedAt)) {
    return todo.resolvedAt;
  }
  if (typeof todo.updatedAt === "number" && Number.isFinite(todo.updatedAt)) {
    return todo.updatedAt;
  }
  return typeof todo.createdAt === "number" && Number.isFinite(todo.createdAt)
    ? todo.createdAt
    : 0;
}

export function launchedTodoEntryId(todoId: string): string {
  return `${LAUNCHED_TODO_ENTRY_PREFIX}${todoId}`;
}

export function isLaunchedTodoEntry(entry: AppServerThreadEntry): boolean {
  return entry.type === "activity" && entry.id.startsWith(LAUNCHED_TODO_ENTRY_PREFIX);
}

export function launchedTodoIdFromEntry(entry: AppServerThreadEntry): string | undefined {
  return isLaunchedTodoEntry(entry)
    ? entry.id.slice(LAUNCHED_TODO_ENTRY_PREFIX.length)
    : undefined;
}

function todoMatchesScope(
  todo: ThreadTodo,
  scope: LaunchedTodoThreadScope | undefined,
): boolean {
  if (!scope) {
    return true;
  }
  return (
    todo.backend === scope.backend
    && todo.threadId === scope.threadId
    && todo.federationTarget?.instanceId === scope.instanceId
  );
}

function compareLaunchedTodos(left: LaunchedTodo, right: LaunchedTodo): number {
  const timeDelta = launchedTodoTimestamp(left) - launchedTodoTimestamp(right);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  const createdDelta = left.createdAt - right.createdAt;
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Filter, deduplicate, and canonically order launched to-dos for one thread.
 * Authoritative fetched cards win over transient launch-tray copies when both
 * carry the same id; duplicates within one source keep the freshest update.
 */
export function filterAndMergeLaunchedTodos(params: {
  fetched: readonly ThreadTodo[];
  transient?: readonly ThreadTodo[];
  scope?: LaunchedTodoThreadScope;
}): LaunchedTodo[] {
  const byId = new Map<string, { todo: LaunchedTodo; authoritative: boolean }>();
  const add = (candidate: ThreadTodo, authoritative: boolean): void => {
    if (!isLaunchedTodo(candidate) || !todoMatchesScope(candidate, params.scope)) {
      return;
    }
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, { todo: candidate, authoritative });
      return;
    }
    if (authoritative && !existing.authoritative) {
      byId.set(candidate.id, { todo: candidate, authoritative: true });
      return;
    }
    if (authoritative === existing.authoritative) {
      const candidateAt = Math.max(candidate.updatedAt, launchedTodoTimestamp(candidate));
      const existingAt = Math.max(existing.todo.updatedAt, launchedTodoTimestamp(existing.todo));
      if (candidateAt > existingAt) {
        byId.set(candidate.id, { todo: candidate, authoritative });
      }
    }
  };

  for (const todo of params.fetched) {
    add(todo, true);
  }
  for (const todo of params.transient ?? []) {
    add(todo, false);
  }

  return [...byId.values()]
    .map((entry) => entry.todo)
    .sort(compareLaunchedTodos);
}

export type InjectLaunchedTodosOptions = {
  /** Older transcript pages exist above `entries`; withhold launches older than the visible window. */
  hasPreviousPage?: boolean;
  /** First entry in the contiguous tail when an earlier prompt is pinned above it. */
  prependAnchorId?: string;
};

/**
 * The launched to-dos that belong in the currently rendered transcript window.
 * When the transcript has no entries yet (loading, read error, or empty
 * history), nothing is injected so empty/loading/error states stay intact.
 * When older pages are not yet loaded, cards launched before the earliest
 * timed entry in the contiguous window stay withheld until scrolling up brings
 * their timestamp range into view.
 */
export function visibleLaunchedTodosForWindow(
  entries: readonly AppServerThreadEntry[],
  launchedTodos: readonly ThreadTodo[] | undefined,
  options?: InjectLaunchedTodosOptions,
): LaunchedTodo[] {
  if (!launchedTodos || launchedTodos.length === 0 || entries.length === 0) {
    return [];
  }
  const normalized = filterAndMergeLaunchedTodos({ fetched: launchedTodos });
  if (normalized.length === 0) {
    return [];
  }
  if (!options?.hasPreviousPage) {
    return normalized;
  }

  const anchorIndex = options.prependAnchorId
    ? entries.findIndex((entry) => entry.id === options.prependAnchorId)
    : -1;
  const startIndex = anchorIndex >= 0 ? anchorIndex : 0;
  let windowStartAt: number | undefined;
  for (let index = startIndex; index < entries.length; index += 1) {
    const createdAt = entries[index]?.createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      if (windowStartAt === undefined || createdAt < windowStartAt) {
        windowStartAt = createdAt;
      }
    }
  }
  if (windowStartAt === undefined) {
    return normalized;
  }
  return normalized.filter((todo) => launchedTodoTimestamp(todo) >= windowStartAt);
}

export function isValidLaunchedThreadLogEntry(
  entry: ThreadLaunchedThread | undefined,
): entry is ThreadLaunchedThread {
  if (!entry || typeof entry.id !== "string" || entry.id.trim().length === 0) {
    return false;
  }
  if (typeof entry.occurredAt !== "number" || !Number.isFinite(entry.occurredAt)) {
    return false;
  }
  const started = entry.startedThread;
  return (
    Boolean(started)
    && typeof started.backend === "string"
    && started.backend.trim().length > 0
    && typeof started.threadId === "string"
    && started.threadId.trim().length > 0
  );
}

function startedThreadDedupeKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
  localInstanceId?: string;
}): string {
  const normalizedInstance =
    params.instanceId && params.instanceId !== params.localInstanceId
      ? params.instanceId
      : "";
  return `${normalizedInstance}:${params.backend}:${params.threadId.trim()}`;
}

function compareLaunchedRecords(
  left: LaunchedThreadRecord,
  right: LaunchedThreadRecord,
): number {
  if (left.launchedAt !== right.launchedAt) {
    return left.launchedAt - right.launchedAt;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Merge to-do launched cards and tool-launched thread log entries into one
 * deduplicated, canonically ordered list for transcript injection.
 * To-do records take precedence if both sources describe the same todoId or
 * started child thread (they carry richer detail/checklist items).
 */
export function mergeLaunchedThreadRecords(params: {
  launchedTodos?: readonly ThreadTodo[];
  launchedThreads?: readonly ThreadLaunchedThread[];
  ownerInstanceId?: string;
  localInstanceId?: string;
  scope?: LaunchedTodoThreadScope;
}): LaunchedThreadRecord[] {
  const todos = filterAndMergeLaunchedTodos({
    fetched: params.launchedTodos ?? [],
    scope: params.scope,
  });
  const records: LaunchedThreadRecord[] = [];
  const seenIds = new Set<string>();
  const seenTodoIds = new Set<string>();
  const seenStartedThreads = new Set<string>();

  for (const todo of todos) {
    seenIds.add(todo.id);
    seenTodoIds.add(todo.id);
    seenStartedThreads.add(
      startedThreadDedupeKey({
        backend: todo.startedThread.backend,
        threadId: todo.startedThread.threadId,
        instanceId: todo.startedThread.instanceId ?? todo.federationTarget?.instanceId,
        localInstanceId: params.localInstanceId,
      }),
    );
    records.push({
      kind: "todo",
      id: todo.id,
      launchedAt: launchedTodoTimestamp(todo),
      createdAt: todo.createdAt,
      todo,
    });
  }

  const toolsById = new Map<string, ThreadLaunchedThread>();
  for (const entry of params.launchedThreads ?? []) {
    if (!isValidLaunchedThreadLogEntry(entry)) {
      continue;
    }
    const existing = toolsById.get(entry.id);
    if (!existing || entry.occurredAt >= existing.occurredAt) {
      toolsById.set(entry.id, entry);
    }
  }

  const sortedTools = [...toolsById.values()].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) {
      return left.occurredAt - right.occurredAt;
    }
    return left.id.localeCompare(right.id);
  });

  for (const launch of sortedTools) {
    if (seenIds.has(launch.id)) {
      continue;
    }
    if (launch.todoId && seenTodoIds.has(launch.todoId)) {
      continue;
    }
    const startedKey = startedThreadDedupeKey({
      backend: launch.startedThread.backend,
      threadId: launch.startedThread.threadId,
      instanceId: launch.startedThread.instanceId ?? params.ownerInstanceId,
      localInstanceId: params.localInstanceId,
    });
    if (seenStartedThreads.has(startedKey)) {
      continue;
    }
    seenIds.add(launch.id);
    seenStartedThreads.add(startedKey);
    records.push({
      kind: "tool",
      id: launch.id,
      launchedAt: launch.occurredAt,
      createdAt: launch.occurredAt,
      launch,
      ...(params.ownerInstanceId ? { ownerInstanceId: params.ownerInstanceId } : {}),
    });
  }

  return records.sort(compareLaunchedRecords);
}

export function visibleLaunchedThreadRecordsForWindow(
  entries: readonly AppServerThreadEntry[],
  records: readonly LaunchedThreadRecord[] | undefined,
  options?: InjectLaunchedTodosOptions,
): LaunchedThreadRecord[] {
  if (!records || records.length === 0 || entries.length === 0) {
    return [];
  }
  const sorted = [...records].sort(compareLaunchedRecords);
  if (!options?.hasPreviousPage) {
    return sorted;
  }
  const anchorIndex = options.prependAnchorId
    ? entries.findIndex((entry) => entry.id === options.prependAnchorId)
    : -1;
  const startIndex = anchorIndex >= 0 ? anchorIndex : 0;
  let windowStartAt: number | undefined;
  for (let index = startIndex; index < entries.length; index += 1) {
    const createdAt = entries[index]?.createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      if (windowStartAt === undefined || createdAt < windowStartAt) {
        windowStartAt = createdAt;
      }
    }
  }
  if (windowStartAt === undefined) {
    return sorted;
  }
  return sorted.filter((record) => record.launchedAt >= windowStartAt);
}

export type PreparedLaunchedThreads = {
  byId: ReadonlyMap<string, LaunchedThreadRecord>;
  records: readonly LaunchedThreadRecord[];
  syntheticEntries: readonly AppServerThreadActivityEntry[];
};

const EMPTY_PREPARED_LAUNCHED: PreparedLaunchedThreads = {
  byId: new Map(),
  records: [],
  syntheticEntries: [],
};

/**
 * Pre-merges, deduplicates, sorts, and materializes synthetic activity entries
 * for a thread's launched cards once when launched inputs change, so streamed
 * transcript chunks pay zero merge/sort/Set-allocation overhead.
 */
export function prepareLaunchedThreadEntries(params: {
  launchedTodos?: readonly ThreadTodo[];
  launchedThreads?: readonly ThreadLaunchedThread[];
  ownerInstanceId?: string;
  localInstanceId?: string;
  scope?: LaunchedTodoThreadScope;
}): PreparedLaunchedThreads {
  if (
    (!params.launchedTodos || params.launchedTodos.length === 0)
    && (!params.launchedThreads || params.launchedThreads.length === 0)
  ) {
    return EMPTY_PREPARED_LAUNCHED;
  }
  const records = mergeLaunchedThreadRecords(params);
  if (records.length === 0) {
    return EMPTY_PREPARED_LAUNCHED;
  }
  const byId = new Map<string, LaunchedThreadRecord>();
  const syntheticEntries: AppServerThreadActivityEntry[] = [];
  for (const record of records) {
    byId.set(record.id, record);
    syntheticEntries.push(buildLaunchedThreadActivityEntry(record));
  }
  return { byId, records, syntheticEntries };
}

/**
 * Fast-path streaming injector for already-prepared, canonically sorted
 * launched-thread entries. Runs in O(1) with zero allocations when there are
 * no launched entries or no transcript entries, and avoids allocating an O(N)
 * id Set on every streamed chunk.
 */
export function injectPreparedLaunchedThreads(
  entries: AppServerThreadEntry[],
  syntheticEntries: readonly AppServerThreadActivityEntry[],
  options?: InjectLaunchedTodosOptions,
): AppServerThreadEntry[] {
  if (syntheticEntries.length === 0 || entries.length === 0) {
    return entries;
  }
  const hasPreviousPage = Boolean(options?.hasPreviousPage);
  const prependAnchorId = options?.prependAnchorId;
  let anchorFound = !hasPreviousPage || !prependAnchorId;
  let windowStartAt: number | undefined;
  let existingLaunchedIds: Set<string> | undefined;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.id.startsWith(LAUNCHED_TODO_ENTRY_PREFIX)) {
      (existingLaunchedIds ??= new Set()).add(entry.id);
    }
    if (hasPreviousPage) {
      if (!anchorFound && entry.id === prependAnchorId) {
        anchorFound = true;
      }
      if (anchorFound) {
        const createdAt = entry.createdAt;
        if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
          if (windowStartAt === undefined || createdAt < windowStartAt) {
            windowStartAt = createdAt;
          }
        }
      }
    }
  }
  // If prependAnchorId was specified but absent, fall back to scanning all entries for min timestamp.
  if (hasPreviousPage && !anchorFound) {
    for (let index = 0; index < entries.length; index += 1) {
      const createdAt = entries[index]?.createdAt;
      if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
        if (windowStartAt === undefined || createdAt < windowStartAt) {
          windowStartAt = createdAt;
        }
      }
    }
  }

  let toInsert: AppServerThreadActivityEntry[] | undefined;
  for (let index = 0; index < syntheticEntries.length; index += 1) {
    const entry = syntheticEntries[index]!;
    if (existingLaunchedIds?.has(entry.id)) {
      continue;
    }
    if (
      hasPreviousPage
      && windowStartAt !== undefined
      && typeof entry.createdAt === "number"
      && entry.createdAt < windowStartAt
    ) {
      continue;
    }
    (toInsert ??= []).push(entry);
  }
  if (!toInsert || toInsert.length === 0) {
    return entries;
  }
  return insertSyntheticEntriesByTime(entries, toInsert);
}

export function buildLaunchedThreadActivityEntry(
  record: LaunchedThreadRecord,
): AppServerThreadActivityEntry {
  if (record.kind === "todo") {
    return buildLaunchedTodoActivityEntry(record.todo);
  }
  const title = record.launch.title.trim() || record.launch.startedThread.threadId;
  const prefix = record.launch.seedMode === "fork"
    ? "Forked thread"
    : record.launch.source === "handoff_task"
      ? "Handed off thread"
      : "Started thread";
  return {
    type: "activity",
    id: launchedTodoEntryId(record.id),
    summary: `${prefix}: ${title}`,
    createdAt: record.launchedAt,
    details: [],
  };
}

export function injectLaunchedThreads(
  entries: AppServerThreadEntry[],
  params: {
    launchedTodos?: readonly ThreadTodo[];
    launchedThreads?: readonly ThreadLaunchedThread[];
    ownerInstanceId?: string;
    localInstanceId?: string;
  },
  options?: InjectLaunchedTodosOptions,
): AppServerThreadEntry[] {
  const prepared = prepareLaunchedThreadEntries(params);
  return injectPreparedLaunchedThreads(entries, prepared.syntheticEntries, options);
}

export function buildLaunchedTodoActivityEntry(todo: LaunchedTodo): AppServerThreadActivityEntry {
  const title = todo.title.trim() || todo.startedThread.threadId;
  return {
    type: "activity",
    id: launchedTodoEntryId(todo.id),
    summary: `Started thread from to-do: ${title}`,
    createdAt: launchedTodoTimestamp(todo),
    details: [],
  };
}

/**
 * Splice launched to-do synthetic entries into the transcript at the moment
 * each card started its thread, without reordering the transcript itself.
 */
export function injectLaunchedTodos(
  entries: AppServerThreadEntry[],
  launchedTodos: readonly ThreadTodo[] | undefined,
  options?: InjectLaunchedTodosOptions,
): AppServerThreadEntry[] {
  const visible = visibleLaunchedTodosForWindow(entries, launchedTodos, options);
  if (visible.length === 0) {
    return entries;
  }
  const existingIds = new Set(entries.map((entry) => entry.id));
  const synthetic = visible
    .map(buildLaunchedTodoActivityEntry)
    .filter((entry) => !existingIds.has(entry.id));
  if (synthetic.length === 0) {
    return entries;
  }
  return insertSyntheticEntriesByTime(entries, synthetic);
}

/**
 * Resolve the started thread's owner into the link frame of the current
 * window:
 * - In the main window (`windowOwnerInstanceId === undefined`), this machine
 *   (`undefined` or `localInstanceId`) is a bare local link (`instanceId: undefined`).
 * - In a remote viewer window serving `windowOwnerInstanceId`, threads on that
 *   window's owner are bare links (`instanceId: undefined`), while threads on
 *   this machine keep `localInstanceId` so `ThreadChip` hides the remote-viewer
 *   pop-out and clicks open them in the main window.
 */
export function resolveLaunchedTodoLinkRef(params: {
  todo: Pick<LaunchedTodo, "action" | "federationTarget" | "startedThread" | "title">;
  localInstanceId?: string;
  windowOwnerInstanceId?: string;
}): LaunchedTodoLinkRef {
  const { todo, localInstanceId, windowOwnerInstanceId } = params;
  const started = todo.startedThread;
  const ownerInstanceId = started.instanceId ?? todo.federationTarget?.instanceId;
  let refInstanceId: string | undefined;
  if (windowOwnerInstanceId) {
    refInstanceId = ownerInstanceId && ownerInstanceId !== windowOwnerInstanceId
      ? ownerInstanceId
      : undefined;
  } else {
    refInstanceId = ownerInstanceId && ownerInstanceId !== localInstanceId
      ? ownerInstanceId
      : undefined;
  }

  const actionTitle = todo.action?.type === "start_thread"
    ? todo.action.title?.trim()
    : undefined;
  const fallbackLabel = actionTitle || todo.title.trim() || started.threadId;
  const instanceLabel =
    refInstanceId && started.instanceId === refInstanceId && started.instanceLabel?.trim()
      ? started.instanceLabel.trim()
      : undefined;

  return {
    backend: started.backend,
    threadId: started.threadId.trim(),
    ...(refInstanceId ? { instanceId: refInstanceId } : {}),
    ...(instanceLabel ? { instanceLabel } : {}),
    fallbackLabel,
  };
}

function extractResultNotice(todo: LaunchedTodo): string | undefined {
  const raw = todo.result?.trim();
  if (!raw) {
    return undefined;
  }
  const segments = raw
    .split(/\.\s+/)
    .map((part) => part.replace(/\.$/, "").trim())
    .filter(Boolean);
  const extra = segments.filter((part) => (
    part !== "Started thread"
    && !part.startsWith("Started thread on ")
    && part !== "Its environment setup failed"
  ));
  return extra.length > 0 ? `${extra.join(". ")}.` : undefined;
}

export function buildLaunchedTodoPresentation(params: {
  todo: LaunchedTodo;
  localInstanceId?: string;
  windowOwnerInstanceId?: string;
}): LaunchedTodoPresentation {
  const { todo } = params;
  const linkRef = resolveLaunchedTodoLinkRef(params);
  const title = todo.title.trim() || linkRef.fallbackLabel;
  const detail = todo.detail?.trim() || undefined;
  const prompt =
    todo.action?.type === "start_thread" || todo.action?.type === "send_message"
      ? todo.action.prompt.trim() || undefined
      : undefined;
  const steps = threadTodoSteps(todo);
  const setupFailure = todo.startedThread.setupFailure?.trim() || undefined;
  const resultNotice = extractResultNotice(todo);

  const facts: string[] = [];
  if (todo.targetProject?.label?.trim()) {
    facts.push(todo.targetProject.label.trim());
  }
  facts.push(formatBackendLabel(todo.startedThread.backend));
  if (linkRef.instanceLabel) {
    facts.push(`on ${linkRef.instanceLabel}`);
  }
  if (steps.length > 0) {
    facts.push(`${steps.length} ${steps.length === 1 ? "plan step" : "plan steps"}`);
  }

  const copyParts = [
    `Started thread from to-do: ${title}`,
    `Thread: ${linkRef.fallbackLabel} (${linkRef.backend}:${linkRef.threadId}${linkRef.instanceLabel ? ` on ${linkRef.instanceLabel}` : ""})`,
    ...(detail ? ["", detail] : []),
    ...(setupFailure ? ["", `Environment setup failed: ${setupFailure}`] : []),
    ...(resultNotice ? ["", resultNotice] : []),
    ...(steps.length > 0 ? ["", "Plan steps:", ...steps.map((step) => `- ${step.text}`)] : []),
    ...(prompt ? ["", "Prompt:", prompt] : []),
  ];

  return {
    ariaLabel: `Launched thread from to-do: ${title}`,
    copyText: copyParts.join("\n"),
    ...(detail ? { detail } : {}),
    facts,
    hasExpandableBody: Boolean(prompt || steps.length > 0 || setupFailure),
    launchedAt: launchedTodoTimestamp(todo),
    linkRef,
    ...(prompt ? { prompt } : {}),
    ...(resultNotice ? { resultNotice } : {}),
    ...(setupFailure ? { setupFailure, statusChipLabel: "Setup failed" } : {}),
    steps,
    title,
    verb: "Started thread",
  };
}

export function buildLaunchedThreadPresentation(params: {
  record: LaunchedThreadRecord;
  localInstanceId?: string;
  windowOwnerInstanceId?: string;
}): LaunchedTodoPresentation {
  const { record, localInstanceId, windowOwnerInstanceId } = params;
  if (record.kind === "todo") {
    return buildLaunchedTodoPresentation({
      todo: record.todo,
      localInstanceId,
      windowOwnerInstanceId,
    });
  }
  const { launch, ownerInstanceId } = record;
  const linkRef = resolveLaunchedTodoLinkRef({
    todo: {
      title: launch.title,
      action: undefined,
      federationTarget: ownerInstanceId
        ? { scope: "remote", instanceId: ownerInstanceId }
        : undefined,
      startedThread: {
        backend: launch.startedThread.backend,
        threadId: launch.startedThread.threadId,
        ...(launch.startedThread.instanceId ? { instanceId: launch.startedThread.instanceId } : {}),
        ...(launch.startedThread.instanceLabel
          ? { instanceLabel: launch.startedThread.instanceLabel }
          : {}),
      },
    },
    localInstanceId,
    windowOwnerInstanceId,
  });

  const verb = launch.seedMode === "fork"
    ? "Forked thread"
    : launch.source === "handoff_task"
      ? "Handed off thread"
      : "Started thread";
  const title = launch.title.trim() || linkRef.fallbackLabel;
  const detail = launch.detail?.trim() || undefined;
  const steps: ThreadTodoItem[] = (launch.steps ?? [])
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: `${launch.id}:step:${index}`,
      text,
      checked: false,
    }));
  const setupFailure = launch.startedThread.setupFailure?.trim() || undefined;
  const turnStartFailure = launch.turnStartFailure?.trim() || undefined;
  const statusChipLabel = setupFailure
    ? "Setup failed"
    : turnStartFailure
      ? "Turn failed"
      : undefined;

  const facts: string[] = [];
  if (launch.projectLabel?.trim()) {
    facts.push(launch.projectLabel.trim());
  }
  facts.push(formatBackendLabel(launch.startedThread.backend));
  if (linkRef.instanceLabel) {
    facts.push(`on ${linkRef.instanceLabel}`);
  }
  if (launch.workspaceMode === "new_worktree" || launch.workspaceMode === "worktree") {
    facts.push("Worktree");
  }
  if (launch.groupingMode === "subthread") {
    facts.push("Subthread");
  }
  if (steps.length > 0) {
    facts.push(`${steps.length} ${steps.length === 1 ? "plan step" : "plan steps"}`);
  }

  const copyParts = [
    `${verb}: ${title}`,
    `Thread: ${linkRef.fallbackLabel} (${linkRef.backend}:${linkRef.threadId}${linkRef.instanceLabel ? ` on ${linkRef.instanceLabel}` : ""})`,
    ...(detail ? ["", detail] : []),
    ...(setupFailure ? ["", `Environment setup failed: ${setupFailure}`] : []),
    ...(turnStartFailure ? ["", `Initial turn failed: ${turnStartFailure}`] : []),
    ...(steps.length > 0 ? ["", "Plan steps:", ...steps.map((step) => `- ${step.text}`)] : []),
  ];

  return {
    ariaLabel: `${verb}: ${title}`,
    copyText: copyParts.join("\n"),
    ...(detail ? { detail } : {}),
    facts,
    hasExpandableBody: Boolean(steps.length > 0 || setupFailure || turnStartFailure),
    launchedAt: launch.occurredAt,
    linkRef,
    ...(setupFailure ? { setupFailure } : {}),
    ...(turnStartFailure ? { turnStartFailure } : {}),
    ...(statusChipLabel ? { statusChipLabel } : {}),
    steps,
    title,
    verb,
  };
}

export type LaunchedTodosTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  federationTarget?: FederationRemoteTarget;
};

export type LaunchedTodosTimerHandle = unknown;

export type LaunchedTodosScheduler = {
  setTimeout: (fn: () => void, ms: number) => LaunchedTodosTimerHandle;
  clearTimeout: (handle: LaunchedTodosTimerHandle) => void;
};

export type LaunchedTodosControllerDeps = {
  listThreadTodos: (request: ListThreadTodosRequest) => Promise<ListThreadTodosResponse>;
  scheduler?: LaunchedTodosScheduler;
  busyRetryMs?: number;
  onStateChange: (state: LaunchedTodosSnapshot) => void;
};

export type LaunchedTodosSnapshot = {
  threadKey: string | undefined;
  todos: LaunchedTodo[];
};

const EMPTY_LAUNCHED: LaunchedTodo[] = [];

export function launchedTodosTargetKey(target: LaunchedTodosTarget | undefined): string | undefined {
  if (!target) {
    return undefined;
  }
  const instance = target.federationTarget?.instanceId ?? "local";
  return `${instance}:${target.backend}:${target.threadId}`;
}

export function eventMatchesLaunchedTodosTarget(
  event: ThreadTodosChangedEvent,
  target: LaunchedTodosTarget,
): boolean {
  const targetInstanceId = target.federationTarget?.instanceId;
  // A remote event only affects threads on that same instance; a broadcast
  // without federationTarget (e.g. peer reconnect) refreshes every owner.
  if (event.federationTarget && event.federationTarget.instanceId !== targetInstanceId) {
    return false;
  }
  if (event.backend === undefined) {
    return true;
  }
  return (
    event.federationTarget?.instanceId === targetInstanceId
    && event.backend === target.backend
    && event.threadId === target.threadId
  );
}

/**
 * Headless async state machine for loading and refreshing one thread's
 * launched to-dos. Serializes reloads per active session so out-of-order
 * fetches, ABA thread switches, busy owners, and transient failures never
 * leak cross-thread cards or clobber newer data with stale responses.
 */
export class LaunchedTodosController {
  private readonly listThreadTodos: LaunchedTodosControllerDeps["listThreadTodos"];
  private readonly scheduler: LaunchedTodosScheduler;
  private readonly busyRetryMs: number;
  private readonly onStateChange: LaunchedTodosControllerDeps["onStateChange"];

  private target: LaunchedTodosTarget | undefined;
  private threadKey: string | undefined;
  private generation = 0;
  private loading = false;
  private queued = false;
  private retryTimer: LaunchedTodosTimerHandle | undefined;
  private retryArmedForCycle = false;
  private disposed = false;
  private fetchedTodos: LaunchedTodo[] = EMPTY_LAUNCHED;

  constructor(deps: LaunchedTodosControllerDeps) {
    this.listThreadTodos = deps.listThreadTodos;
    this.scheduler = deps.scheduler ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.busyRetryMs = deps.busyRetryMs ?? THREAD_TODO_BUSY_RETRY_MS;
    this.onStateChange = deps.onStateChange;
  }

  getSnapshot(): LaunchedTodosSnapshot {
    return {
      threadKey: this.threadKey,
      todos: this.fetchedTodos,
    };
  }

  setTarget(nextTarget: LaunchedTodosTarget | undefined): void {
    if (this.disposed) {
      return;
    }
    const nextKey = launchedTodosTargetKey(nextTarget);
    if (nextKey === this.threadKey) {
      return;
    }
    this.generation += 1;
    this.clearRetryTimer();
    this.loading = false;
    this.queued = false;
    this.retryArmedForCycle = false;
    this.target = nextTarget;
    this.threadKey = nextKey;
    this.fetchedTodos = EMPTY_LAUNCHED;
    this.emit();
    if (nextTarget) {
      void this.triggerReload();
    }
  }

  handleTodosChanged(event: ThreadTodosChangedEvent): void {
    if (this.disposed || !this.target) {
      return;
    }
    if (!eventMatchesLaunchedTodosTarget(event, this.target)) {
      return;
    }
    // A fresh change event earns a fresh busy-retry budget.
    this.retryArmedForCycle = false;
    this.clearRetryTimer();
    void this.triggerReload();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    this.clearRetryTimer();
    this.loading = false;
    this.queued = false;
  }

  private emit(): void {
    this.onStateChange({
      threadKey: this.threadKey,
      todos: this.fetchedTodos,
    });
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      this.scheduler.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private scheduleBusyRetry(gen: number): void {
    if (this.disposed || gen !== this.generation || this.retryArmedForCycle) {
      return;
    }
    this.retryArmedForCycle = true;
    this.clearRetryTimer();
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.disposed || gen !== this.generation) {
        return;
      }
      void this.triggerReload();
    }, this.busyRetryMs);
  }

  private async triggerReload(): Promise<void> {
    if (this.disposed || !this.target) {
      return;
    }
    if (this.loading) {
      this.queued = true;
      return;
    }
    const gen = this.generation;
    const activeTarget = this.target;
    const scope: LaunchedTodoThreadScope = {
      backend: activeTarget.backend,
      threadId: activeTarget.threadId,
      ...(activeTarget.federationTarget ? { instanceId: activeTarget.federationTarget.instanceId } : {}),
    };
    this.loading = true;
    try {
      do {
        this.queued = false;
        try {
          const response = await this.listThreadTodos({
            backend: activeTarget.backend,
            threadId: activeTarget.threadId,
            status: "done",
            ...(activeTarget.federationTarget ? { federationTarget: activeTarget.federationTarget } : {}),
          });
          if (this.disposed || gen !== this.generation) {
            return;
          }
          const busyForThisThread = (response.busyThreads ?? []).some((busy) => (
            busy.backend === activeTarget.backend
            && busy.threadId === activeTarget.threadId
            && busy.federationTarget.instanceId === activeTarget.federationTarget?.instanceId
          ));
          if (busyForThisThread) {
            this.scheduleBusyRetry(gen);
            continue;
          }
          const next = filterAndMergeLaunchedTodos({
            fetched: response.todos,
            scope,
          });
          if (!sameLaunchedTodoList(this.fetchedTodos, next)) {
            this.fetchedTodos = next.length > 0 ? next : EMPTY_LAUNCHED;
            this.emit();
          }
        } catch (error) {
          if (this.disposed || gen !== this.generation) {
            return;
          }
          if (isNavigationBusy(error)) {
            this.scheduleBusyRetry(gen);
          }
          // Preserve last known cards on transient errors rather than wiping them.
        }
      } while (this.queued && !this.disposed && gen === this.generation);
    } finally {
      if (gen === this.generation) {
        this.loading = false;
      }
    }
  }
}

function sameLaunchedTodoList(
  left: readonly LaunchedTodo[],
  right: readonly LaunchedTodo[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    const aPrompt =
      a.action?.type === "start_thread" || a.action?.type === "send_message"
        ? a.action.prompt
        : undefined;
    const bPrompt =
      b.action?.type === "start_thread" || b.action?.type === "send_message"
        ? b.action.prompt
        : undefined;
    if (
      a.id !== b.id
      || a.updatedAt !== b.updatedAt
      || a.resolvedAt !== b.resolvedAt
      || a.title !== b.title
      || a.detail !== b.detail
      || a.result !== b.result
      || a.targetProject?.label !== b.targetProject?.label
      || (a.items?.length ?? 0) !== (b.items?.length ?? 0)
      || a.action?.type !== b.action?.type
      || aPrompt !== bPrompt
      || a.startedThread.backend !== b.startedThread.backend
      || a.startedThread.threadId !== b.startedThread.threadId
      || a.startedThread.instanceId !== b.startedThread.instanceId
      || a.startedThread.instanceLabel !== b.startedThread.instanceLabel
      || a.startedThread.setupFailure !== b.startedThread.setupFailure
    ) {
      return false;
    }
  }
  return true;
}
