import type { AppServerBackendKind, FederationInstanceId } from "@pwragent/shared";

export function turnFailureScopeKey(
  backend: AppServerBackendKind,
  threadId: string,
  instanceId?: FederationInstanceId,
): string {
  return JSON.stringify([instanceId ?? null, backend, threadId]);
}

export function turnFailureNoticeId(params: {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
  instanceId?: FederationInstanceId;
}): string {
  const localId = `turn-failed:${params.backend}:${params.threadId}:${params.turnId}`;
  return params.instanceId ? `${localId}:instance:${params.instanceId}` : localId;
}

/** Window-local acknowledgement, independent of the persisted failure audit. */
export function createTurnFailureAcknowledgements() {
  const latest = new Map<string, Map<string, { id: string; dismissed: boolean }>>();
  const scopesById = new Map<string, { scope: string; message: string }>();
  const listeners = new Map<string, Set<() => void>>();
  const dismissalListeners = new Set<(id: string) => void>();
  const notify = (scope: string): void => {
    for (const listener of listeners.get(scope) ?? []) listener();
  };
  const dismiss = (id: string): boolean => {
    const identity = scopesById.get(id);
    if (!identity) return false;
    const { scope, message } = identity;
    const failure = latest.get(scope)?.get(message);
    if (!failure || failure.dismissed) return false;
    failure.dismissed = true;
    notify(scope);
    for (const listener of dismissalListeners) listener(id);
    return true;
  };
  return {
    report(scope: string, id: string, message: string): void {
      let messages = latest.get(scope);
      if (!messages) { messages = new Map(); latest.set(scope, messages); }
      const previous = messages.get(message);
      // A replay of the same incident must not undo acknowledgement.
      if (previous?.id === id) return;
      if (previous) scopesById.delete(previous.id);
      messages.set(message, { id, dismissed: false });
      scopesById.set(id, { scope, message });
      notify(scope);
    },
    dismiss,
    dismissMatching(scope: string | undefined, message: string | undefined): void {
      if (!scope || !message) return;
      const failure = latest.get(scope)?.get(message);
      // Queue hold events carry the failure message but no failed-turn ID.
      // Only acknowledge the latest matching incident on this owner/thread.
      if (failure) dismiss(failure.id);
    },
    isDismissed(scope: string | undefined, message: string | undefined): boolean {
      if (!scope || !message) return false;
      return latest.get(scope)?.get(message)?.dismissed ?? false;
    },
    subscribe(scope: string | undefined, listener: () => void): () => void {
      if (!scope) return () => undefined;
      let scoped = listeners.get(scope);
      if (!scoped) { scoped = new Set(); listeners.set(scope, scoped); }
      scoped.add(listener);
      return () => {
        scoped.delete(listener);
        if (scoped.size === 0) listeners.delete(scope);
      };
    },
    subscribeDismissals(listener: (id: string) => void): () => void {
      dismissalListeners.add(listener);
      return () => { dismissalListeners.delete(listener); };
    },
  };
}

export const turnFailureAcknowledgements = createTurnFailureAcknowledgements();
