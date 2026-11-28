import type { FederationCapability, FederationTarget } from "./federation";
import { isAppServerBackendKind, isNavigationThreadRunning, type NavigationThreadSummary } from "./navigation";
import type { AppServerBackendKind, ThreadIdentifier } from "./normalized-app-server";

/**
 * The owner holds `settledAt` on its threads and answers
 * `backend.setThreadSettledV1` and `backend.settleDirectoryUnpinnedV1`. A
 * viewer offers no Settle, Unsettle or Settle Unpinned… on an older owner's
 * threads, and an older owner's projects draw no Settled section.
 */
export const THREAD_SETTLE_FEDERATION_CAPABILITY = "thread_settle_snooze" satisfies FederationCapability;

/**
 * Whether an owner that advertises these capabilities takes Settle from this
 * machine: it holds Settle and lets this machine change its sidebar.
 */
export function ownerTakesSettle(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(THREAD_SETTLE_FEDERATION_CAPABILITY) === true
    && capabilities.includes("thread_navigation");
}

/**
 * Whether a row offers Settle at all. Roots only. In this instance's own
 * windows (`windowOwnerTakesSettle` undefined) a local row always does and a
 * peer's row does while that peer is connected and takes Settle. In a peer's
 * window, the window's owner decides for every row.
 */
export function threadSettleOffered(
  thread: Pick<NavigationThreadSummary, "parentThreadId" | "codexNativeSubAgent" | "federation">,
  windowOwnerTakesSettle?: boolean,
): boolean {
  if (thread.parentThreadId || thread.codexNativeSubAgent !== undefined) return false;
  if (windowOwnerTakesSettle !== undefined) return windowOwnerTakesSettle;
  return !thread.federation
    || (thread.federation.peerStatus === "connected" && ownerTakesSettle(thread.federation.capabilities));
}

/** Why Settle is refused for a thread right now, or undefined when it is allowed. */
export type ThreadSettleRefusal = "subthread" | "running" | "queued";

/**
 * Settle files a root thread away. It is refused while the thread needs the
 * operator or is doing work: a live turn (which is also where an approval or
 * question waits), a running sub-agent or background task, or a queued send.
 * Refusing never stops or cancels anything.
 */
export function threadSettleRefusal(
  thread: Pick<NavigationThreadSummary, "parentThreadId" | "threadStatus" | "hasActiveSubAgent" | "hasBackgroundTasks" | "queuedTurns">,
): ThreadSettleRefusal | undefined {
  if (thread.parentThreadId) return "subthread";
  if (isNavigationThreadRunning(thread)) return "running";
  if ((thread.queuedTurns?.length ?? 0) > 0) return "queued";
  return undefined;
}

export function threadSettleRefusalText(refusal: ThreadSettleRefusal): string {
  switch (refusal) {
    case "subthread":
      return "Sub-threads are settled with their parent";
    case "running":
      return "Working now; settle it once it is idle";
    case "queued":
      return "Has a queued message waiting to send";
  }
}

export type SetThreadSettledRequest = {
  backend?: AppServerBackendKind;
  federationTarget?: FederationTarget;
  threadId: ThreadIdentifier;
  settled: boolean;
  /**
   * Settle includes Mark Read: the displayed update the operator saw, so the
   * read watermark never moves past output they have not seen.
   */
  seenUpdatedAt?: number;
};

export type SetThreadSettledResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Present while the thread is settled. */
  settledAt?: number;
  /** Settle was refused; nothing changed. */
  refusal?: ThreadSettleRefusal;
};

export type SettleDirectoryUnpinnedCandidate = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  updatedAt?: number;
};

/** The most threads one Settle Unpinned… lists and settles. */
export const SETTLE_DIRECTORY_UNPINNED_MAX_THREADS = 1_000;

export type SettleDirectoryUnpinnedRequest = {
  federationTarget?: FederationTarget;
  directoryKey: string;
  /**
   * Absent asks for the candidates without changing anything. Present
   * settles exactly these, as the operator confirmed them; the owner skips
   * any that has since been pinned, settled, or started work.
   */
  threads?: Array<{ backend: AppServerBackendKind; threadId: ThreadIdentifier; seenUpdatedAt?: number }>;
};

export type SettleDirectoryUnpinnedResponse = {
  directoryKey: string;
  /** The idle unpinned roots that Settle would file, oldest activity last. */
  candidates: SettleDirectoryUnpinnedCandidate[];
  /** Unpinned roots left out because they are working or have a queued send. */
  skippedBusy: number;
  /** Execution only: how many threads were settled. */
  settled?: number;
};

const isBackend = (value: unknown): value is AppServerBackendKind =>
  typeof value === "string" && isAppServerBackendKind(value);
const isThreadId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const isWatermark = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** A peer's request, checked before the owner acts on it; undefined when malformed. */
export function readSetThreadSettledRequest(
  value: unknown,
): Omit<SetThreadSettledRequest, "federationTarget"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  if (!isThreadId(request.threadId) || typeof request.settled !== "boolean"
    || (request.backend !== undefined && !isBackend(request.backend))
    || !isWatermark(request.seenUpdatedAt)) return undefined;
  return {
    threadId: request.threadId,
    settled: request.settled,
    ...(request.backend !== undefined ? { backend: request.backend } : {}),
    ...(request.seenUpdatedAt !== undefined ? { seenUpdatedAt: request.seenUpdatedAt as number } : {}),
  };
}

/** A peer's Settle Unpinned… request, bounded; undefined when malformed. */
export function readSettleDirectoryUnpinnedRequest(
  value: unknown,
): Omit<SettleDirectoryUnpinnedRequest, "federationTarget"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  if (typeof request.directoryKey !== "string" || !request.directoryKey || request.directoryKey.length > 4_096) return undefined;
  if (request.threads === undefined) return { directoryKey: request.directoryKey };
  if (!Array.isArray(request.threads) || request.threads.length > SETTLE_DIRECTORY_UNPINNED_MAX_THREADS) return undefined;
  const threads: NonNullable<SettleDirectoryUnpinnedRequest["threads"]> = [];
  for (const entry of request.threads as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const thread = entry as Record<string, unknown>;
    if (!isBackend(thread.backend) || !isThreadId(thread.threadId) || !isWatermark(thread.seenUpdatedAt)) return undefined;
    threads.push({
      backend: thread.backend,
      threadId: thread.threadId,
      ...(thread.seenUpdatedAt !== undefined ? { seenUpdatedAt: thread.seenUpdatedAt as number } : {}),
    });
  }
  return { directoryKey: request.directoryKey, threads };
}
