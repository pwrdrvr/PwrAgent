import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSettingsRecent } from "@pwragent/shared/contracts/agent";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { DesktopApi } from "../../lib/desktop-api";

type Lists = { composer: ModelSettingsRecent[]; todoDispatch: ModelSettingsRecent[] };

const EMPTY: Lists = { composer: [], todoDispatch: [] };

function authorityKey(target: FederationTarget | undefined): string {
  return target?.scope === "remote" ? `remote:${target.instanceId}` : "local";
}

/**
 * The settings recent new threads started with, read from the instance that
 * will own the next one: its catalog is the one that has to run them. Read
 * when a launchpad appears and again each time its model panel opens, so a
 * thread started a moment ago is already there.
 */
export function useNewThreadRecents(params: {
  api: Pick<DesktopApi, "listModelSettingsRecents"> | undefined;
  /** Only a launchpad starts a thread; nothing is read without one. */
  enabled: boolean;
  federationTarget: FederationTarget | undefined;
}): Lists & { refresh: () => void } {
  const { api, enabled, federationTarget } = params;
  const key = authorityKey(federationTarget);
  const [state, setState] = useState<Lists & { key: string }>({ ...EMPTY, key });
  const targetRef = useRef(federationTarget);
  targetRef.current = federationTarget;
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(() => {
    const list = api?.listModelSettingsRecents;
    if (!enabled || !list) return;
    const requested = keyRef.current;
    const target = targetRef.current;
    const read = (scope: "composer" | "todo-dispatch") =>
      list({ ...(target ? { federationTarget: target } : {}), scope })
        .then((response) => response.recents)
        .catch(() => [] as ModelSettingsRecent[]);
    void Promise.all([read("composer"), read("todo-dispatch")]).then(([composer, todoDispatch]) => {
      // A response for an owner the launchpad has since left is dropped.
      if (keyRef.current !== requested) return;
      setState({ composer, todoDispatch, key: requested });
    });
  }, [api, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh, key]);

  // Another owner's history never shows while this one's loads.
  return { ...(state.key === key ? state : EMPTY), refresh };
}
