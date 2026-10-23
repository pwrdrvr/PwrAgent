import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  ThreadTodo,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoStatus,
} from "@pwragent/shared";
import { threadTodoThreadKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadTodoResolveOptions } from "./thread-todos-view";

export type ThreadTodosController = {
  error?: string;
  /** Open cards, newest first. */
  openTodos: ThreadTodo[];
  /** Open cards per `backend:threadId`, newest first. */
  openByThreadKey: ReadonlyMap<string, ThreadTodo[]>;
  /** Bumps on every change event, so a Done list can refetch. */
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
   * card, which arrives with the change event's refetch.
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
  | "listThreadTodos"
  | "onThreadTodosChanged"
  | "resolveThreadTodo"
  | "runThreadTodoAction"
  | "setThreadTodoItemChecked"
>;

const EMPTY_TODOS: ThreadTodo[] = [];
const EMPTY_MAP: ReadonlyMap<string, ThreadTodo[]> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Open thread to-dos for this window, routed to each owning instance.
 *
 * The change event is a marker: every one triggers one list call, and calls
 * that arrive while a list is in flight collapse into a single follow-up.
 */
export function useThreadTodos(
  desktopApi: ThreadTodosApi | undefined,
  mountedThreadKeys = "",
): ThreadTodosController {
  const api = desktopApi;
  const [error, setError] = useState<string>();
  const [openTodos, setOpenTodos] = useState<ThreadTodo[]>(EMPTY_TODOS);
  const [revision, setRevision] = useState(0);
  const [mergeMethods, setMergeMethods] = useState<ThreadTodoMergeMethodPreferences>();
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const loadingRef = useRef(false);
  const reloadQueuedRef = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    const list = api?.listThreadTodos;
    if (!list) return;
    if (loadingRef.current) {
      reloadQueuedRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      do {
        reloadQueuedRef.current = false;
        try {
          const response = await list({ status: "open" });
          setError(response.errors?.join("\n"));
          setOpenTodos(response.todos.length > 0 ? response.todos : EMPTY_TODOS);
          if (response.mergeMethods) setMergeMethods(response.mergeMethods);
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
      } while (reloadQueuedRef.current);
    } finally {
      loadingRef.current = false;
    }
  }, [api]);

  useEffect(() => {
    void reload();
    const unsubscribe = api?.onThreadTodosChanged?.(() => {
      setRevision((current) => current + 1);
      void reload();
    });
    return () => unsubscribe?.();
  }, [api, reload, mountedThreadKeys]);

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
