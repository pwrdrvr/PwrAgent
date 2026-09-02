import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import {
  BACKEND_SUMMARIES_REFRESH_EVENT,
  useBackendSummaries,
} from "../useBackendSummaries";

describe("useBackendSummaries", () => {
  it("distinguishes pending discovery from a completed empty result", async () => {
    let resolveBackends!: (value: {
      fetchedAt: number;
      backends: [];
    }) => void;
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>(
      async () => await new Promise((resolve) => {
        resolveBackends = resolve;
      }),
    );
    const { result } = renderHook(() => useBackendSummaries({ listBackends }));

    expect(result.current.loaded).toBe(false);

    await act(async () => {
      resolveBackends({ fetchedAt: 1, backends: [] });
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
  });

  it("refreshes cached ACP models only when explicitly requested", async () => {
    const listAcpAgents = vi
      .fn<NonNullable<DesktopApi["listAcpAgents"]>>()
      .mockResolvedValue({
        fetchedAt: 2,
        entries: [],
      });
    const staleKimi = {
      kind: "acp:kimi" as const,
      source: "acp" as const,
      label: "Kimi",
      available: true,
      methods: [],
      capabilities: {
        listThreads: true,
        createThread: true,
        resumeThread: true,
        renameThread: true,
        readThread: true,
        startTurn: true,
        interruptTurn: true,
        steerTurn: false,
        transcriptPagination: false,
        toolUse: true,
        approvalRequests: true,
        multiDirectoryThreads: true,
      },
      executionModes: [],
      launchpadOptions: {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "Kimi-k2.6",
            current: true,
          },
        ],
      },
    };
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValueOnce({
        fetchedAt: 1,
        backends: [staleKimi],
      })
      .mockResolvedValue({
        fetchedAt: 2,
        backends: [
          {
            ...staleKimi,
            launchpadOptions: {
              models: [
                {
                  id: "kimi-code/kimi-for-coding",
                  label: "K2.7 Coding",
                  current: true,
                },
                {
                  id: "kimi-code/k3",
                  label: "K3",
                },
              ],
            },
          },
        ],
      });

    const desktopApi: DesktopApi = {
      listAcpAgents,
      listBackends,
    };
    const { result } = renderHook(() => useBackendSummaries(desktopApi));

    await waitFor(() => {
      expect(result.current.backends[0]?.launchpadOptions?.models).toEqual([
        expect.objectContaining({ label: "Kimi-k2.6" }),
      ]);
    });
    expect(listAcpAgents).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshAcpAgents();
    });

    await waitFor(() => {
      expect(result.current.backends[0]?.launchpadOptions?.models).toEqual([
        expect.objectContaining({ label: "K2.7 Coding" }),
        expect.objectContaining({ label: "K3" }),
      ]);
    });
    expect(listAcpAgents).not.toHaveBeenCalled();
    expect(listBackends).toHaveBeenCalledTimes(2);
  });

  it("refreshes backend details when ACP provider status updates", async () => {
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValue({
        fetchedAt: 1,
        backends: [],
      });
    const desktopApi: DesktopApi = {
      listBackends,
      onAgentEvent: (callback) => {
        eventHandler = callback;
        return () => undefined;
      },
    };

    renderHook(() => useBackendSummaries(desktopApi));

    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledTimes(1);
    });
    eventHandler?.({
      backend: "acp:grok",
      notification: {
        method: "backend/providerStatus/updated",
        params: { backend: "acp:grok" },
      },
    });

    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes backend details when Codex rate limits update", async () => {
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValueOnce({
        fetchedAt: 1,
        backends: [
          {
            kind: "codex",
            label: "OpenAI",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        fetchedAt: 2,
        backends: [
          {
            kind: "codex",
            label: "OpenAI",
            available: true,
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            rateLimits: [{ name: "5h limit", usedPercent: 15, remaining: 85 }],
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        fetchedAt: 3,
        backends: [
          {
            kind: "codex",
            label: "OpenAI",
            available: true,
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "team",
            },
            rateLimits: [{ name: "5h limit", usedPercent: 10, remaining: 90 }],
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [],
          },
        ],
      });
    const desktopApi: DesktopApi = {
      listBackends,
      onAgentEvent: (callback) => {
        eventHandler = callback;
        return () => undefined;
      },
    };

    const { result } = renderHook(() => useBackendSummaries(desktopApi));

    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledTimes(1);
    });

    eventHandler?.({
      backend: "codex",
      notification: {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
          },
        },
      },
    });

    await waitFor(() => {
      expect(result.current.backends[0]?.account?.planType).toBe("pro");
      expect(result.current.backends[0]?.rateLimits?.[0]?.remaining).toBe(85);
    });

    eventHandler?.({
      backend: "codex",
      notification: {
        method: "account/updated",
        params: {
          account: {
            planType: "team",
          },
        },
      },
    });

    await waitFor(() => {
      expect(result.current.backends[0]?.account?.planType).toBe("team");
      expect(result.current.backends[0]?.rateLimits?.[0]?.remaining).toBe(90);
    });
  });

  it("refreshes backend details when settings request a summary refresh", async () => {
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValueOnce({
        fetchedAt: 1,
        backends: [
          {
            kind: "acp:grok",
            label: "Grok",
            available: false,
            unavailableReason: "Grok API key is not set",
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: true,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: false,
            },
            executionModes: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        fetchedAt: 2,
        backends: [
          {
            kind: "acp:grok",
            label: "Grok",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: true,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: false,
            },
            executionModes: [],
          },
        ],
      });
    const desktopApi: DesktopApi = {
      listBackends,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useBackendSummaries(desktopApi));

    await waitFor(() => {
      expect(result.current.backends[0]?.available).toBe(false);
    });

    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));

    await waitFor(() => {
      expect(result.current.backends[0]?.available).toBe(true);
    });
    expect(listBackends).toHaveBeenCalledTimes(2);
  });

  it("refreshes ACP model details when runtime capabilities update", async () => {
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValueOnce({
        fetchedAt: 1,
        backends: [
          {
            kind: "acp:kimi",
            source: "acp",
            label: "Kimi Code CLI",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              archiveThread: true,
              restoreThread: true,
              archiveWorktree: false,
              restoreWorktree: false,
              renameThread: true,
              readThread: true,
              startTurn: true,
              startReview: false,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: true,
              approvalRequests: true,
              multiDirectoryThreads: true,
            },
            executionModes: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        fetchedAt: 2,
        backends: [
          {
            kind: "acp:kimi",
            source: "acp",
            label: "Kimi Code CLI",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              archiveThread: true,
              restoreThread: true,
              archiveWorktree: false,
              restoreWorktree: false,
              renameThread: true,
              readThread: true,
              startTurn: true,
              startReview: false,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: true,
              approvalRequests: true,
              multiDirectoryThreads: true,
            },
            executionModes: [],
            launchpadOptions: {
              models: [
                {
                  id: "kimi-code/kimi-for-coding,thinking",
                  label: "kimi-for-coding (thinking)",
                  current: true,
                },
              ],
            },
          },
        ],
      });
    const desktopApi: DesktopApi = {
      listBackends,
      onAgentEvent: (callback) => {
        eventHandler = callback;
        return () => undefined;
      },
    };

    const { result } = renderHook(() => useBackendSummaries(desktopApi));

    await waitFor(() => {
      expect(result.current.backends[0]?.launchpadOptions).toBeUndefined();
    });

    eventHandler?.({
      backend: "acp:kimi",
      notification: {
        method: "backend/acpRuntimeCapabilities/updated",
        params: {
          backend: "acp:kimi",
        },
      },
    });

    await waitFor(() => {
      expect(result.current.backends[0]?.launchpadOptions?.models?.[0]).toMatchObject({
        id: "kimi-code/kimi-for-coding,thinking",
        label: "kimi-for-coding (thinking)",
      });
    });
    expect(listBackends).toHaveBeenCalledTimes(2);
  });

  it("loads backend summaries from the selected remote instance", async () => {
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const listAcpAgents = vi.fn();
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValue({ fetchedAt: 1, backends: [] });
    const desktopApi: DesktopApi = {
      listAcpAgents,
      listBackends,
      onAgentEvent: (callback) => {
        eventHandler = callback;
        return () => undefined;
      },
    };

    const { result } = renderHook(() => useBackendSummaries(desktopApi, {
      federationTarget,
    }));

    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledWith({
        includeUnavailable: true,
        federationTarget,
      });
    });

    await act(async () => {
      await result.current.refreshAcpAgents();
    });
    expect(listAcpAgents).not.toHaveBeenCalled();
    expect(listBackends).toHaveBeenCalledTimes(2);

    eventHandler?.({
      backend: "codex",
      notification: {
        method: "account/updated",
        params: {},
      },
    });
    await act(async () => undefined);
    expect(listBackends).toHaveBeenCalledTimes(2);

    eventHandler?.({
      backend: "codex",
      federationTarget,
      notification: {
        method: "account/updated",
        params: {},
      },
    });
    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledTimes(3);
    });
  });

  it("preserves remote backend summaries while disconnected and refreshes on reconnect", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const codexBackend = {
      kind: "codex" as const,
      label: "OpenAI",
      available: true,
      methods: [],
      capabilities: {
        listThreads: true,
        createThread: true,
        resumeThread: true,
        renameThread: true,
        readThread: true,
        startTurn: true,
        interruptTurn: true,
        steerTurn: false,
        transcriptPagination: false,
        toolUse: false,
        approvalRequests: false,
        multiDirectoryThreads: true,
      },
      executionModes: [],
    };
    let rejectOutageRead: ((error: Error) => void) | undefined;
    const outageRead = new Promise<never>((_resolve, reject) => {
      rejectOutageRead = reject;
    });
    const listBackends = vi
      .fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValueOnce({
        fetchedAt: 1,
        backends: [codexBackend],
      })
      .mockReturnValueOnce(outageRead)
      .mockResolvedValueOnce({
        fetchedAt: 2,
        backends: [{ ...codexBackend, label: "OpenAI reconnected" }],
      });
    const desktopApi: DesktopApi = {
      listBackends,
    };
    const { rerender, result } = renderHook(
      ({ suspended }) => useBackendSummaries(desktopApi, {
        federationTarget,
        suspended,
      }),
      { initialProps: { suspended: false } },
    );

    await waitFor(() => {
      expect(result.current.backends[0]?.label).toBe("OpenAI");
    });

    act(() => {
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
    });
    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledTimes(2);
    });
    rerender({ suspended: true });
    await act(async () => {
      rejectOutageRead?.(new Error("Federation peer is not connected"));
      await outageRead.catch(() => undefined);
    });

    expect(result.current.backends[0]?.label).toBe("OpenAI");
    expect(result.current.error).toBeUndefined();
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
    expect(listBackends).toHaveBeenCalledTimes(2);

    rerender({ suspended: false });
    await waitFor(() => {
      expect(result.current.backends[0]?.label).toBe("OpenAI reconnected");
    });
    expect(listBackends).toHaveBeenCalledTimes(3);
  });
});
