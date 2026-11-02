import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BackendSummary, CodexSpeed, FederationTarget, ThreadTodo, ThreadTodoModelSettings, ThreadTodoWorkMode, ThreadTodoMessageTarget,
} from "@pwragent/shared";
import { threadTodoThreadKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * What the operator chose on one card besides the owner's model pick. Each
 * per-machine record is keyed by machine (`local` or an instance id), so
 * moving the card to another machine and back finds its earlier choices.
 */
export type TodoDispatchChoices = {
  /** Absent: the card's owner. */
  machine?: string;
  models?: Readonly<Record<string, ThreadTodoModelSettings>>;
  speeds?: Readonly<Record<string, CodexSpeed>>;
  /** An environment id, or `none`. */
  environments?: Readonly<Record<string, string>>;
  workMode?: ThreadTodoWorkMode;
  /** The start settings show as the labelled grid instead of the chip row. */
  settingsExpanded?: boolean;
  dispatchMode?: "message" | "new_thread";
  messageTarget?: ThreadTodoMessageTarget;
};

type DispatchContext = {
  /** False for the default context, which keeps no choices. */
  provided: boolean;
  api?: Pick<DesktopApi, "listBackends" | "listModelSettingsRecents" | "listThreadTodoDispatchEnvironments" | "searchThreads">;
  /** Settings → Models → Allow Fast mode, on this window's own machine. */
  localCodexFastAllowed: boolean;
  choices: ReadonlyMap<string, TodoDispatchChoices>;
  choose: (todo: ThreadTodo, update: (current: TodoDispatchChoices) => TodoDispatchChoices) => void;
  backends: BackendSummary[];
  backendsTarget?: FederationTarget;
  ownerBackends: ReadonlyMap<string, BackendSummary[]>;
  loadOwnerBackends: (target: FederationTarget, refresh?: boolean) => void;
  picks: ReadonlyMap<string, ThreadTodoModelSettings>;
  pick: (todo: ThreadTodo, settings: ThreadTodoModelSettings) => void;
};

const EMPTY_PICKS: ReadonlyMap<string, ThreadTodoModelSettings> = new Map();
const EMPTY_CATALOGS: ReadonlyMap<string, BackendSummary[]> = new Map();
const EMPTY_CHOICES: ReadonlyMap<string, TodoDispatchChoices> = new Map();
const Context = createContext<DispatchContext>({
  provided: false, localCodexFastAllowed: true, choices: EMPTY_CHOICES, choose: () => {},
  backends: [], ownerBackends: EMPTY_CATALOGS, loadOwnerBackends: () => {}, picks: EMPTY_PICKS, pick: () => {},
});

export function todoDispatchPickKey(todo: ThreadTodo): string {
  return JSON.stringify([threadTodoThreadKey(todo), todo.id]);
}

/** Window-local picks survive paging and moving between the stack and To-dos. */
export function TodoDispatchProvider(props: {
  api?: DispatchContext["api"];
  backends: BackendSummary[];
  /** The catalog supplied by App can belong to the thread selected on a peer. */
  backendsTarget?: FederationTarget;
  todos: ThreadTodo[];
  localCodexFastAllowed?: boolean;
  children: ReactNode;
}) {
  const [picks, setPicks] = useState(EMPTY_PICKS);
  const [choices, setChoices] = useState(EMPTY_CHOICES);
  const [ownerBackends, setOwnerBackends] = useState(EMPTY_CATALOGS);
  const catalogsRef = useRef(EMPTY_CATALOGS);
  const loadingRef = useRef(new Set<string>());
  const api = props.api;
  const loadOwnerBackends = useCallback((target: FederationTarget, refresh = false) => {
    const key = target.scope === "remote" ? target.instanceId : "local";
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
    const prune = <T,>(current: ReadonlyMap<string, T>): ReadonlyMap<string, T> =>
      [...current.keys()].every((key) => open.has(key)) ? current
        : new Map([...current].filter(([key]) => open.has(key)));
    setPicks(prune);
    setChoices(prune);
  }, [props.todos]);
  const choose = useCallback((todo: ThreadTodo, update: (current: TodoDispatchChoices) => TodoDispatchChoices) => {
    const key = todoDispatchPickKey(todo);
    setChoices((current) => new Map(current).set(key, update(current.get(key) ?? {})));
  }, []);
  const localCodexFastAllowed = props.localCodexFastAllowed !== false;
  const value = useMemo<DispatchContext>(() => ({
    provided: true,
    api: props.api,
    localCodexFastAllowed,
    choices,
    choose,
    backends: props.backends,
    backendsTarget: props.backendsTarget,
    ownerBackends,
    loadOwnerBackends,
    picks,
    pick: (todo, settings) => setPicks((current) => new Map(current).set(todoDispatchPickKey(todo), settings)),
  }), [props.api, localCodexFastAllowed, choices, choose, props.backends, props.backendsTarget, ownerBackends, loadOwnerBackends, picks]);
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useTodoDispatchContext() {
  return useContext(Context);
}

/**
 * One machine's catalog: this window's own for `local`, else that
 * instance's, loaded on first use. Undefined until it loads.
 */
export function useTodoMachineBackends(machineKey: string, refresh = false): BackendSummary[] | undefined {
  const context = useTodoDispatchContext();
  const load = context.loadOwnerBackends;
  const remote = machineKey !== "local";
  const suppliedLocal = context.backendsTarget?.scope !== "remote";
  useEffect(() => {
    if (remote) load({ scope: "remote", instanceId: machineKey }, refresh);
    else if (!suppliedLocal) load({ scope: "local" }, refresh);
  }, [remote, suppliedLocal, machineKey, load, refresh]);
  return remote || !suppliedLocal ? context.ownerBackends.get(machineKey) : context.backends;
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
