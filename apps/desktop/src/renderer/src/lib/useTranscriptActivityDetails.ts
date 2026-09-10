import { useCallback, useEffect, useRef, useState } from "react";
import type { AppServerThreadActivityEntry } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

/** A collapsed row owns no detail read. Repeated expansion shares one request. */
export function useTranscriptActivityDetails(params: {
  entry: AppServerThreadActivityEntry;
  expanded: boolean;
  desktopApi?: Pick<DesktopApi, "readThread">;
  instanceId?: string;
}) {
  const ref = params.entry.detailsRef;
  const hasDeferredDetails = Boolean(ref);
  const key = JSON.stringify([params.instanceId, ref]);
  const current = useRef(params);
  current.current = params;
  const [state, setState] = useState<{ key: string; entry?: AppServerThreadActivityEntry; loading?: boolean; error?: string }>({ key });
  const pending = useRef<{ key: string; promise: Promise<AppServerThreadActivityEntry> } | undefined>(undefined);
  const loaded = useRef<{ key: string; entry: AppServerThreadActivityEntry } | undefined>(undefined);
  const mountedKey = useRef<string | undefined>(key);
  mountedKey.current = key;
  useEffect(() => {
    mountedKey.current = key;
    return () => { mountedKey.current = undefined; };
  }, [key]);
  const load = useCallback(async (): Promise<AppServerThreadActivityEntry> => {
    const { entry, desktopApi, instanceId } = current.current;
    if (!entry.detailsRef) return entry;
    if (loaded.current?.key === key) return loaded.current.entry;
    if (pending.current?.key === key) return pending.current.promise;
    setState({ key, loading: true });
    const promise = (async () => {
      await Promise.resolve();
      try {
        if (!desktopApi?.readThread) throw new Error("Activity details are unavailable.");
        const response = await desktopApi.readThread({
          backend: entry.detailsRef!.backend, threadId: entry.detailsRef!.threadId,
          ...(instanceId ? { federationTarget: { scope: "remote", instanceId } as const } : {}),
          display: { resource: "activity", activity: { turnId: entry.detailsRef!.turnId, entryId: entry.id } },
          viewOnly: true,
        });
        const full = response.replay.entries.find((item): item is AppServerThreadActivityEntry => item.type === "activity" && item.id === entry.id);
        if (!full || full.detailsRef) throw new Error("Activity details are no longer available. Reload the thread.");
        // The base row owns status/timestamps. The one-turn read supplies only
        // detail bodies and must not change completed-turn presentation.
        const resolved = { ...entry, details: full.details, detailsRef: undefined };
        if (mountedKey.current === key) {
          loaded.current = { key, entry: resolved };
          setState({ key, entry: resolved });
        }
        return resolved;
      } catch (error) {
        if (mountedKey.current === key) setState({ key, error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        if (pending.current?.key === key) pending.current = undefined;
      }
    })();
    pending.current = { key, promise };
    return promise;
  }, [key]);
  useEffect(() => {
    if (params.expanded && hasDeferredDetails) void load().catch(() => undefined);
  }, [params.expanded, hasDeferredDetails, load]);
  return { ...(state.key === key ? state : {}), entry: state.key === key && state.entry ? state.entry : params.entry, load };
}
