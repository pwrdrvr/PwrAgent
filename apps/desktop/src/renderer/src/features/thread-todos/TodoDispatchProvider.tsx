import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BackendSummary, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { threadTodoThreadKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type DispatchContext = {
  api?: Pick<DesktopApi, "listBackends" | "listModelSettingsRecents">;
  backends: BackendSummary[];
  picks: ReadonlyMap<string, ThreadTodoModelSettings>;
  pick: (todo: ThreadTodo, settings: ThreadTodoModelSettings) => void;
};

const EMPTY_PICKS: ReadonlyMap<string, ThreadTodoModelSettings> = new Map();
const Context = createContext<DispatchContext>({ backends: [], picks: EMPTY_PICKS, pick: () => {} });

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
    picks,
    pick: (todo, settings) => setPicks((current) => new Map(current).set(todoDispatchPickKey(todo), settings)),
  }), [props.api, props.backends, picks]);
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useTodoDispatchContext() {
  return useContext(Context);
}
