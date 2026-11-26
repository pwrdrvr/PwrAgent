import { useEffect, useMemo, useRef, useState } from "react";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "../../lib/desktop-api";
import { useThreadTodoLaunches } from "../thread-todos/thread-todo-launches";
import {
  filterAndMergeLaunchedTodos,
  LaunchedTodosController,
  launchedTodosTargetKey,
  type LaunchedTodo,
  type LaunchedTodosSnapshot,
  type LaunchedTodosTarget,
} from "./launched-todo-entries";

const EMPTY_LAUNCHED_TODOS: LaunchedTodo[] = [];

type LaunchedTodosApi = Pick<DesktopApi, "listThreadTodos" | "onThreadTodosChanged">;

export function useThreadLaunchedTodos(params: {
  desktopApi?: LaunchedTodosApi;
  thread?: {
    backend: AppServerBackendKind;
    threadId: string;
    federationTarget?: FederationRemoteTarget;
  };
  /** `backend:threadId` (owner-qualified when remote), matching `useThreadTodoLaunches`. */
  threadKey?: string;
}): readonly LaunchedTodo[] {
  const api = params.desktopApi;
  const backend = params.thread?.backend;
  const threadId = params.thread?.threadId;
  const instanceId = params.thread?.federationTarget?.instanceId;
  const target = useMemo<LaunchedTodosTarget | undefined>(
    () => (
      backend && threadId
        ? {
            backend,
            threadId,
            ...(instanceId
              ? { federationTarget: { scope: "remote" as const, instanceId } }
              : {}),
          }
        : undefined
    ),
    [backend, instanceId, threadId],
  );
  const targetKey = launchedTodosTargetKey(target);

  const [snapshot, setSnapshot] = useState<LaunchedTodosSnapshot>({
    threadKey: undefined,
    todos: EMPTY_LAUNCHED_TODOS,
  });
  const controllerRef = useRef<LaunchedTodosController | undefined>(undefined);

  useEffect(() => {
    const listThreadTodos = api?.listThreadTodos;
    if (!listThreadTodos) {
      controllerRef.current = undefined;
      setSnapshot({ threadKey: undefined, todos: EMPTY_LAUNCHED_TODOS });
      return;
    }
    const controller = new LaunchedTodosController({
      listThreadTodos,
      onStateChange: setSnapshot,
    });
    controllerRef.current = controller;
    const unsubscribe = api.onThreadTodosChanged?.((event) => {
      controller.handleTodosChanged(event);
    });
    return () => {
      unsubscribe?.();
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
    };
  }, [api]);

  useEffect(() => {
    controllerRef.current?.setTarget(target);
  }, [api, target]);

  // Also read settled launches from the stack tray so a newly launched card
  // appears immediately in the transcript before the IPC reload settles.
  const { launches } = useThreadTodoLaunches(params.threadKey ?? "");
  const settledTransient = useMemo(
    () => launches
      .filter((launch) => launch.phase === "started" || launch.phase === "setup_failed")
      .map((launch) => launch.todo),
    [launches],
  );

  const fetched = snapshot.threadKey === targetKey ? snapshot.todos : EMPTY_LAUNCHED_TODOS;

  return useMemo(() => {
    if (!target) {
      return EMPTY_LAUNCHED_TODOS;
    }
    if (settledTransient.length === 0) {
      return fetched;
    }
    return filterAndMergeLaunchedTodos({
      fetched,
      transient: settledTransient,
      scope: {
        backend: target.backend,
        threadId: target.threadId,
        ...(target.federationTarget ? { instanceId: target.federationTarget.instanceId } : {}),
      },
    });
  }, [fetched, settledTransient, target]);
}
