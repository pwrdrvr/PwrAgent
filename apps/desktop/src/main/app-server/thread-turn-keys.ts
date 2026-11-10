import {
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  buildThreadIdentityKey,
  isAcpBackendId,
} from "@pwragent/shared";



export function buildPendingRequestKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
  requestId: string;
}): string {
  return `${params.backend}:${params.threadId}:${params.requestId}`;
}

export function buildTerminalNotificationKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
}): string {
  return `${params.backend}:${params.threadId}:turn-terminal`;
}

export function executionModeQueueKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

export function buildActiveTurnModeKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function buildActiveTurnKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

export function turnInputAttachmentCacheKey(item: AppServerTurnInputItem): string {
  if (item.type === "localImage" || item.type === "localFile") {
    return `${item.type}:${item.path}`;
  }
  if (item.type === "image") {
    return `${item.type}:${item.url}`;
  }
  if (item.type === "file") {
    return `${item.type}:${item.name}:${item.data}`;
  }
  return `${item.type}:${item.text}`;
}

export function buildReviewSubAgentKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return buildActiveTurnKey(backend, threadId, turnId);
}

export function reviewSubAgentId(turnId: string): string {
  return `review:${turnId}`;
}

export function parseThreadTurnKeyBody(
  body: string,
): { threadId: string; turnId: string } | undefined {
  const pendingSeparator = body.indexOf(":pending:");
  if (pendingSeparator > 0) {
    const beforePending = body.slice(0, pendingSeparator);
    const afterPending = body.slice(pendingSeparator + ":pending:".length);
    if (beforePending === afterPending || afterPending.startsWith(`${beforePending}:`)) {
      return { threadId: beforePending, turnId: `pending:${afterPending}` };
    }
  }
  const turnSeparator = body.lastIndexOf(":");
  if (turnSeparator <= 0) return undefined;
  return {
    threadId: body.slice(0, turnSeparator),
    turnId: body.slice(turnSeparator + 1),
  };
}

export function parseActiveTurnKey(
  key: string,
): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined {
  if (key.startsWith("acp:")) {
    const registrySeparator = key.indexOf(":", "acp:".length);
    if (registrySeparator <= "acp:".length) return undefined;
    const backend = key.slice(0, registrySeparator);
    if (!isAcpBackendId(backend)) return undefined;
    const parsed = parseThreadTurnKeyBody(
      key.slice(registrySeparator + 1),
    );
    return parsed ? { backend, ...parsed } : undefined;
  }

  const backendSeparator = key.indexOf(":");
  if (backendSeparator <= 0) return undefined;
  const backend = key.slice(0, backendSeparator);
  if (backend !== "codex" && backend !== "claude") return undefined;
  const parsed = parseThreadTurnKeyBody(
    key.slice(backendSeparator + 1),
  );
  return parsed ? { backend, ...parsed } : undefined;
}

export function parseThreadIdFromThreadTurnKeyBody(body: string): string | undefined {
  return parseThreadTurnKeyBody(body)?.threadId;
}

export function buildHeadlessAutomationTurnKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

export function buildTurnStartReservationKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `${backend}\u0000${threadId}`;
}

export function parseReservedAcpStartThreadKey(
  key: string,
): { backend: AppServerBackendKind; threadId: string } | undefined {
  const [backend, threadId] = key.split("\u0000");
  if (!backend || !threadId || !isAcpBackendId(backend)) {
    return undefined;
  }
  return { backend, threadId };
}

/**
 * Quit blockers are keyed the same way as every other thread identity, so the
 * quit dialog can parse them back into `{backend, threadId}` and link to the
 * thread. The hand-rolled `${backend}:${threadId}` this used to build was
 * ambiguous for ACP backends, whose kind ("acp:grok") already contains a colon.
 */
export function formatQuitThreadKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

export function taskMonitorThreadKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `${backend}:${threadId}`;
}

/**
 * The registry's running turns. Removal is observable, so a quit can wait for
 * each turn it stopped to end, whichever terminal path removes it.
 */
export class ActiveTurnKeySet extends Set<string> {
  private readonly deleteListeners = new Set<(key: string) => void>();

  override delete(key: string): boolean {
    const deleted = super.delete(key);
    if (deleted) {
      for (const listener of this.deleteListeners) {
        listener(key);
      }
    }
    return deleted;
  }

  onDelete(listener: (key: string) => void): () => void {
    this.deleteListeners.add(listener);
    return () => {
      this.deleteListeners.delete(listener);
    };
  }
}
