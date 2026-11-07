import type {
  AppServerBackendKind,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoItem,
  ThreadTodoKind,
  ThreadTodoMergeMethod,
  ThreadTodoModelSettings,
  ThreadTodoProject,
  ThreadTodoStatus,
} from "@pwragent/shared";

export type ThreadTodoResult = Pick<ThreadTodo, "result" | "startedThread">;

export type InsertThreadTodoRecord = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  key?: string;
  kind: ThreadTodoKind;
  title: string;
  detail?: string;
  action?: ThreadTodoAction;
  cwd?: string;
  sourceProject?: ThreadTodoProject;
  targetProject?: ThreadTodoProject;
  items?: ThreadTodoItem[];
  dependencyId?: string;
  now: number;
};

export type ReplaceThreadTodoContentRecord = {
  id: string;
  kind: ThreadTodoKind;
  title: string;
  detail?: string;
  /** The whole list as it should read; absent or empty clears it. */
  items?: ThreadTodoItem[];
  action?: ThreadTodoAction;
  cwd?: string;
  sourceProject?: ThreadTodoProject;
  targetProject?: ThreadTodoProject;
  now: number;
};

/** Thread cards and dispatch preferences without host database handles. */
export interface ThreadTodoStorage {
  transaction<T>(work: () => T): T;
  insert(record: InsertThreadTodoRecord): ThreadTodo;
  replaceContent(record: ReplaceThreadTodoContentRecord): ThreadTodo;
  setStatus(params: {
    id: string;
    status: ThreadTodoStatus;
    now: number;
    result?: ThreadTodoResult;
  }): ThreadTodo;
  setItems(params: { id: string; items: ThreadTodoItem[]; now: number }): ThreadTodo;
  setError(params: { id: string; error: string; now: number }): ThreadTodo;
  get(id: string): ThreadTodo | undefined;
  findByDependency(dependencyId: string): ThreadTodo | undefined;
  findOpenByKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
    key: string;
  }): ThreadTodo | undefined;
  countOpen(params: { backend: AppServerBackendKind; threadId: string }): number;
  list(params: {
    status?: ThreadTodoStatus | "all";
    backend?: AppServerBackendKind;
    threadId?: string;
    limit?: number;
  }): ThreadTodo[];
  dismissOpenForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    now: number;
  }): number;
  getThreadModelSettings(backend: AppServerBackendKind, threadId: string): ThreadTodoModelSettings | undefined;
  setThreadModelSettings(backend: AppServerBackendKind, threadId: string, settings: ThreadTodoModelSettings): void;
  rememberDispatch(backend: AppServerBackendKind, threadId: string, settings: ThreadTodoModelSettings, source: ThreadTodoModelSettings): void;
  listProjectMergeMethods(): Record<string, ThreadTodoMergeMethod>;
  getProjectMergeMethod(directoryKey: string): ThreadTodoMergeMethod | undefined;
  setProjectMergeMethod(params: {
    directoryKey: string;
    method: ThreadTodoMergeMethod;
    now: number;
  }): boolean;
}
