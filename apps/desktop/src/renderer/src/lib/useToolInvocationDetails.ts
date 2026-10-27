import { useCallback, useEffect, useRef, useState } from "react";
import type { AppServerThreadActivityDetail, ThreadToolInvocationRecord } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

/** Item bodies are view-local. They never enter the ordered transcript. */
export function useToolInvocationDetails(params: {
  invocation: ThreadToolInvocationRecord;
  enabled: boolean;
  desktopApi?: Pick<DesktopApi, "readThread">;
  instanceId?: string;
}) {
  const { invocation, instanceId } = params;
  // Refresh at completion, not for every streamed accounting update.
  const key = JSON.stringify([instanceId, invocation.backend, invocation.threadId, invocation.turnId, invocation.itemId,
    invocation.status, invocation.completedAt,
  ]);
  const [state, setState] = useState<{
    key: string; details?: AppServerThreadActivityDetail[]; loading?: boolean; error?: string;
  }>({ key });
  const current = useRef(params);
  current.current = params;
  const mountedKey = useRef<string | undefined>(key);
  mountedKey.current = key;
  const pending = useRef<{ key: string; promise: Promise<void> } | undefined>(undefined);
  const loaded = useRef<{ key: string; details: AppServerThreadActivityDetail[] } | undefined>(undefined);
  useEffect(() => {
    mountedKey.current = key;
    return () => { mountedKey.current = undefined; };
  }, [key]);
  const load = useCallback(async () => {
    if (loaded.current?.key === key) return;
    if (pending.current?.key === key) return pending.current.promise;
    setState({ key, loading: true });
    const { invocation: target, desktopApi: api, instanceId: owner } = current.current;
    const promise = (async () => {
      await Promise.resolve();
      try {
        if (!api?.readThread || !target.turnId) throw new Error("Tool invocation details are unavailable.");
        const response = await api.readThread({
          backend: target.backend, threadId: target.threadId, viewOnly: true,
          ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } as const } : {}),
          display: { resource: "activity", activity: {
            turnId: target.turnId, entryId: `activity-${target.itemId}`, invocationItemId: target.itemId,
          } },
        });
        const result = response.toolInvocationDetails;
        if (response.backend !== target.backend || response.threadId !== target.threadId
          || result?.turnId !== target.turnId || result.itemId !== target.itemId || !result.details.length) {
          throw new Error("Tool invocation details are unavailable. Load the transcript to view this command.");
        }
        if (mountedKey.current === key) {
          loaded.current = { key, details: result.details };
          setState({ key, details: result.details });
        }
      } catch (error) {
        if (mountedKey.current === key) setState({ key, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (pending.current?.key === key) pending.current = undefined;
      }
    })();
    pending.current = { key, promise };
    return promise;
  }, [key]);
  useEffect(() => {
    if (params.enabled) void load();
  }, [params.enabled, load]);
  return { ...(state.key === key ? state : {}), load };
}
