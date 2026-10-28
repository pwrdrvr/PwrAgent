import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  ThreadTodo,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoStatus,
  TodoUnavailableInstance,
} from "@pwragent/shared";
import { applyThreadTodoFeedDelta, ThreadTodoFeedFollower, threadTodoThreadKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadTodoResolveOptions } from "./thread-todos-view";

export type ThreadTodosController = {
  error?: string;
  unavailableInstances: TodoUnavailableInstance[];
  /** Open cards, newest first. */
  openTodos: ThreadTodo[];
  /** Open cards per `backend:threadId`, newest first. */
  openByThreadKey: ReadonlyMap<string, ThreadTodo[]>;
  /** Bumps on every applied snapshot and delta, so a Done list can refetch. */
  revision: number;
  mergeMethods?: ThreadTodoMergeMethodPreferences;
  /** Ids whose main-process action is running in this window. */
  runningIds: ReadonlySet<string>;
  resolve: (
    id: string,
    status: ThreadTodoStatus,
    resolution?: ResolveThreadTodoRequest["resolution"],
    options?: ThreadTodoResolveOptions,
  ) => Promise<ThreadTodo | undefined>;
  /**
   * Ticks or unticks one step. Not optimistic: the box follows the stored
   * card, which arrives in the change's delta.
   */
  setItemChecked: (
    id: string,
    itemId: string,
    checked: boolean,
  ) => Promise<ThreadTodo | undefined>;
  runAction: (
    id: string,
    options?: Omit<RunThreadTodoActionRequest, "id">,
  ) => Promise<ThreadTodo | undefined>;
};

type ThreadTodosApi = Pick<
  DesktopApi,
  | "snapshotThreadTodos"
  | "onThreadTodosDelta"
  | "resolveThreadTodo"
  | "runThreadTodoAction"
  | "setThreadTodoItemChecked"
>;

const EMPTY_TODOS: ThreadTodo[] = [];
const EMPTY_MAP: ReadonlyMap<string, ThreadTodo[]> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_UNAVAILABLE: TodoUnavailableInstance[] = [];

function sameMergeMethods(
  current: ThreadTodoMergeMethodPreferences | undefined,
  next: ThreadTodoMergeMethodPreferences,
): ThreadTodoMergeMethodPreferences {
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

/**
 * Open thread to-dos for this window, routed to each owning instance.
 *
 * The window reads one snapshot, then applies each delta in revision order.
 * It reads a new snapshot only for a revision gap, a new epoch, a resync,
 * or a change to the mounted remote threads, never per change.
 */
export function useThreadTodos(
  desktopApi: ThreadTodosApi | undefined,
  mountedThreadKeys = "",
): ThreadTodosController {
  const api = desktopApi;
  const [error, setError] = useState<string>();
  const [unavailableInstances, setUnavailableInstances] = useState(EMPTY_UNAVAILABLE);
  const [openTodos, setOpenTodos] = useState<ThreadTodo[]>(EMPTY_TODOS);
  const [revision, setRevision] = useState(0);
  const [mergeMethods, setMergeMethods] = useState<ThreadTodoMergeMethodPreferences>();
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(EMPTY_SET);

  useEffect(() => {
    const snapshot = api?.snapshotThreadTodos;
    if (!snapshot) return;
    // The cards the follower last applied, so a delta needs no state read.
    let todos = EMPTY_TODOS;
    const show = (next: ThreadTodo[]): void => {
      if (next === todos) return;
      todos = next.length > 0 ? next : EMPTY_TODOS;
      setOpenTodos(todos);
    };
    const follower = new ThreadTodoFeedFollower({
      fetch: () => snapshot(),
      onSnapshot: (state) => {
        show(state.todos);
        setError(state.errors?.length ? state.errors.join("\n") : undefined);
        setUnavailableInstances(state.unavailableInstances?.length ? state.unavailableInstances : EMPTY_UNAVAILABLE);
        const methods = state.mergeMethods;
        if (methods) setMergeMethods((current) => sameMergeMethods(current, methods));
        setRevision((current) => current + 1);
      },
      onDelta: (delta) => {
        show(applyThreadTodoFeedDelta(todos, delta));
        if (delta.errors) setError(delta.errors.length > 0 ? delta.errors.join("\n") : undefined);
        if (delta.unavailableInstances) {
          setUnavailableInstances(delta.unavailableInstances.length > 0
            ? delta.unavailableInstances : EMPTY_UNAVAILABLE);
        }
        const methods = delta.mergeMethods;
        if (methods) setMergeMethods((current) => sameMergeMethods(current, methods));
        setRevision((current) => current + 1);
      },
      onError: (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
    });
    const unsubscribe = api.onThreadTodosDelta?.((delta) => follower.receive(delta));
    void follower.sync();
    return () => {
      follower.close();
      unsubscribe?.();
    };
  }, [api, mountedThreadKeys]);

  const resolve = useCallback(
    async (
      id: string,
      status: ThreadTodoStatus,
      resolution?: ResolveThreadTodoRequest["resolution"],
      options?: ThreadTodoResolveOptions,
    ): Promise<ThreadTodo | undefined> => {
      const response = await api?.resolveThreadTodo?.({
        id,
        status,
        ...(resolution ? { resolution } : {}),
        ...(options?.allowOpenItems ? { allowOpenItems: true } : {}),
      });
      return response?.todo;
    },
    [api],
  );

  const setItemChecked = useCallback(
    async (id: string, itemId: string, checked: boolean): Promise<ThreadTodo | undefined> =>
      (await api?.setThreadTodoItemChecked?.({ id, itemId, checked }))?.todo,
    [api],
  );

  const runAction = useCallback(
    async (
      id: string,
      options: Omit<RunThreadTodoActionRequest, "id"> = {},
    ): Promise<ThreadTodo | undefined> => {
      if (!api?.runThreadTodoAction) return undefined;
      setRunningIds((current) => new Set(current).add(id));
      try {
        return (await api.runThreadTodoAction({ ...options, id })).todo;
      } finally {
        setRunningIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next.size > 0 ? next : EMPTY_SET;
        });
      }
    },
    [api],
  );

  const openByThreadKey = useMemo(() => {
    if (openTodos.length === 0) return EMPTY_MAP;
    const map = new Map<string, ThreadTodo[]>();
    for (const todo of openTodos) {
      const key = threadTodoThreadKey(todo);
      const list = map.get(key);
      if (list) list.push(todo);
      else map.set(key, [todo]);
    }
    return map;
  }, [openTodos]);

  return useMemo(
    () => ({
      error,
      unavailableInstances,
      openTodos,
      openByThreadKey,
      revision,
      mergeMethods,
      runningIds,
      resolve,
      runAction,
      setItemChecked,
    }),
    [
      error,
      unavailableInstances,
      openTodos,
      openByThreadKey,
      revision,
      mergeMethods,
      runningIds,
      resolve,
      runAction,
      setItemChecked,
    ],
  );
}

/**
 * Open cards per thread key, for the sidebar's count chip. A context rather
 * than a prop: the chip sits five list components below App, and every one
 * of them would otherwise carry a prop it never reads.
 */
export const ThreadTodoCountsContext = createContext<
  ReadonlyMap<string, ThreadTodo[]>
>(EMPTY_MAP);

export function useThreadTodosForKey(threadKey: string): ThreadTodo[] {
  return useContext(ThreadTodoCountsContext).get(threadKey) ?? EMPTY_TODOS;
}
