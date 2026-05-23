import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  AutomationDetail,
  AutomationIdRequest,
  AutomationRunArtifact,
  AutomationRunRollout,
  AutomationRunSummary,
  CreateAutomationRequest,
  ListAutomationsRequest,
  ThreadIdentifier,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type AutomationState = {
  automations: AutomationDetail[];
  error?: string;
  loading: boolean;
  refreshing: boolean;
};

export type UseAutomationsResult = AutomationState & {
  createAutomation: (request: CreateAutomationRequest) => Promise<AutomationDetail>;
  deleteAutomation: (request: AutomationIdRequest) => Promise<AutomationDetail>;
  pauseAutomation: (request: AutomationIdRequest) => Promise<AutomationDetail>;
  refresh: () => Promise<void>;
  resumeAutomation: (request: AutomationIdRequest) => Promise<AutomationDetail>;
  runAutomationNow: (request: AutomationIdRequest) => Promise<void>;
  updateAutomation: (request: UpdateAutomationRequest) => Promise<AutomationDetail>;
};

export function useAutomations(
  desktopApi: DesktopApi | undefined,
  request?: ListAutomationsRequest,
): UseAutomationsResult {
  const [state, setState] = useState<AutomationState>({
    automations: [],
    loading: Boolean(desktopApi?.listAutomations),
    refreshing: false,
  });
  const requestKey = useMemo(() => JSON.stringify(request ?? {}), [request]);

  const refresh = useCallback(async () => {
    if (!desktopApi?.listAutomations) {
      setState({
        automations: [],
        error: "Automation IPC is unavailable.",
        loading: false,
        refreshing: false,
      });
      return;
    }

    setState((current) => ({
      ...current,
      error: undefined,
      loading: current.automations.length === 0,
      refreshing: current.automations.length > 0,
    }));

    try {
      const response = await desktopApi.listAutomations(request);
      setState({
        automations: response.automations,
        loading: false,
        refreshing: false,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: formatAutomationError(error),
        loading: false,
        refreshing: false,
      }));
    }
  }, [desktopApi, requestKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      if (
        event.notification.method === "thread/automations/updated" ||
        event.notification.method === "automation/run/updated"
      ) {
        void refresh();
      }
    });
  }, [desktopApi, refresh]);

  const mutate = useCallback(
    async <TRequest,>(
      action: ((request: TRequest) => Promise<{ automation: AutomationDetail }>) | undefined,
      request: TRequest,
      fallback: string,
    ): Promise<AutomationDetail> => {
      if (!action) {
        throw new Error("Automation IPC is unavailable.");
      }

      try {
        const response = await action(request);
        await refresh();
        return response.automation;
      } catch (error) {
        setState((current) => ({
          ...current,
          error: formatAutomationError(error, fallback),
        }));
        throw error;
      }
    },
    [refresh],
  );

  const createAutomation = useCallback(
    (createRequest: CreateAutomationRequest) =>
      mutate(desktopApi?.createAutomation, createRequest, "Automation could not be created."),
    [desktopApi, mutate],
  );
  const updateAutomation = useCallback(
    (updateRequest: UpdateAutomationRequest) =>
      mutate(desktopApi?.updateAutomation, updateRequest, "Automation could not be updated."),
    [desktopApi, mutate],
  );
  const deleteAutomation = useCallback(
    (deleteRequest: AutomationIdRequest) =>
      mutate(desktopApi?.deleteAutomation, deleteRequest, "Automation could not be deleted."),
    [desktopApi, mutate],
  );
  const pauseAutomation = useCallback(
    (pauseRequest: AutomationIdRequest) =>
      mutate(desktopApi?.pauseAutomation, pauseRequest, "Automation could not be paused."),
    [desktopApi, mutate],
  );
  const resumeAutomation = useCallback(
    (resumeRequest: AutomationIdRequest) =>
      mutate(desktopApi?.resumeAutomation, resumeRequest, "Automation could not be resumed."),
    [desktopApi, mutate],
  );
  const runAutomationNow = useCallback(
    async (runRequest: AutomationIdRequest) => {
      if (!desktopApi?.runAutomationNow) {
        throw new Error("Automation IPC is unavailable.");
      }
      try {
        await desktopApi.runAutomationNow(runRequest);
        await refresh();
      } catch (error) {
        setState((current) => ({
          ...current,
          error: formatAutomationError(error, "Automation could not be queued."),
        }));
        throw error;
      }
    },
    [desktopApi, refresh],
  );

  return {
    ...state,
    createAutomation,
    deleteAutomation,
    pauseAutomation,
    refresh,
    resumeAutomation,
    runAutomationNow,
    updateAutomation,
  };
}

export function useAutomationRuns(
  desktopApi: DesktopApi | undefined,
  automationId: string | undefined,
): {
  error?: string;
  loading: boolean;
  refresh: () => Promise<void>;
  runs: AutomationRunSummary[];
} {
  const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!automationId || !desktopApi?.listAutomationRuns) {
      setRuns([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const response = await desktopApi.listAutomationRuns({
        automationId,
        limit: 20,
      });
      setRuns(response.runs);
    } catch (candidate) {
      setError(formatAutomationError(candidate, "Automation runs could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [automationId, desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!automationId || !desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      if (event.notification.method !== "automation/run/updated") {
        return;
      }

      const params = event.notification.params as Record<string, unknown> | undefined;
      if (params?.automationId === automationId) {
        void refresh();
      }
    });
  }, [automationId, desktopApi, refresh]);

  return { error, loading, refresh, runs };
}

export function useAutomationRunArtifact(
  desktopApi: DesktopApi | undefined,
  runId: string | undefined,
): {
  artifact?: AutomationRunArtifact;
  error?: string;
  loading: boolean;
  rollout?: AutomationRunRollout;
} {
  const [artifact, setArtifact] = useState<AutomationRunArtifact>();
  const [rollout, setRollout] = useState<AutomationRunRollout>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    if (!runId || !desktopApi?.getAutomationRunArtifact) {
      setArtifact(undefined);
      setRollout(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    void desktopApi
      .getAutomationRunArtifact({ runId })
      .then((response) => {
        if (!cancelled) {
          setArtifact(response.artifact);
          setRollout(response.rollout);
        }
      })
      .catch((candidate) => {
        if (!cancelled) {
          setError(formatAutomationError(candidate, "Automation artifact could not be loaded."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, runId]);

  return { artifact, error, loading, rollout };
}

export function sameAutomationThread(
  automation: AutomationDetail,
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): boolean {
  return automation.backend === backend && automation.threadId === threadId;
}

function formatAutomationError(error: unknown, fallback = "Automation request failed."): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
