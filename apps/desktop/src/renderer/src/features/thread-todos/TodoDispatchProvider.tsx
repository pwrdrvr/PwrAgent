import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BackendSummary, FederationRemoteTarget, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { threadTodoThreadKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type DispatchContext = {
  api?: Pick<DesktopApi, "listBackends" | "listModelSettingsRecents">;
  backends: BackendSummary[];
  ownerBackends: ReadonlyMap<string, BackendSummary[]>;
  loadOwnerBackends: (target: FederationRemoteTarget, refresh?: boolean) => void;
  picks: ReadonlyMap<string, ThreadTodoModelSettings>;
  pick: (todo: ThreadTodo, settings: ThreadTodoModelSettings) => void;
};

const EMPTY_PICKS: ReadonlyMap<string, ThreadTodoModelSettings> = new Map();
const EMPTY_CATALOGS: ReadonlyMap<string, BackendSummary[]> = new Map();
const Context = createContext<DispatchContext>({
  backends: [], ownerBackends: EMPTY_CATALOGS, loadOwnerBackends: () => {}, picks: EMPTY_PICKS, pick: () => {},
});

export function todoDispatchPickKey(todo: ThreadTodo): string {
  return JSON.stringify([threadTodoThreadKey(todo), todo.id]);
}

/** Window-local picks survive paging and moving between the stack and To-dos. */
export function TodoDispatchProvider(props: {
  api?: DispatchContext["api"];
  backends: BackendSummary[];
  todos: ThreadTodo[];
  children: ReactNode;
}) {
  const [picks, setPicks] = useState(EMPTY_PICKS);
  const [ownerBackends, setOwnerBackends] = useState(EMPTY_CATALOGS);
  const catalogsRef = useRef(EMPTY_CATALOGS);
  const loadingRef = useRef(new Set<string>());
  const api = props.api;
  const loadOwnerBackends = useCallback((target: FederationRemoteTarget, refresh = false) => {
    const key = target.instanceId;
    if (!api?.listBackends || loadingRef.current.has(key) || (!refresh && catalogsRef.current.has(key))) return;
    loadingRef.current.add(key);
    void api.listBackends({ federationTarget: target }).then((response) => {
      const next = new Map(catalogsRef.current).set(key, response.backends);
      catalogsRef.current = next;
      setOwnerBackends(next);
    }).catch(() => {}).finally(() => loadingRef.current.delete(key));
  }, [api]);
  useEffect(() => {
    const open = new Set(props.todos.map(todoDispatchPickKey));
    setPicks((current) => {
      if ([...current.keys()].every((key) => open.has(key))) return current;
      return new Map([...current].filter(([key]) => open.has(key)));
    });
  }, [props.todos]);
  const value = useMemo<DispatchContext>(() => ({
    api: props.api,
    backends: props.backends,
    ownerBackends,
    loadOwnerBackends,
    picks,
    pick: (todo, settings) => setPicks((current) => new Map(current).set(todoDispatchPickKey(todo), settings)),
  }), [props.api, props.backends, ownerBackends, loadOwnerBackends, picks]);
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useTodoDispatchContext() {
  return useContext(Context);
}

/** The chip and its provenance use the same owner catalog, including on mounted peer cards. */
export function useTodoDispatchBackends(todo: ThreadTodo, refresh = false): BackendSummary[] {
  const context = useTodoDispatchContext();
  const target = todo.federationTarget;
  const load = context.loadOwnerBackends;
  useEffect(() => {
    if (target) load(target, refresh);
  }, [target, load, refresh]);
  return (target ? context.ownerBackends.get(target.instanceId) : undefined) ?? context.backends;
}
