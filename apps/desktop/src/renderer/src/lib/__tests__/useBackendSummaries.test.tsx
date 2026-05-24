import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import {
  BACKEND_SUMMARIES_REFRESH_EVENT,
  useBackendSummaries,
} from "../useBackendSummaries";

describe("useBackendSummaries", () => {
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
            kind: "grok",
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
            kind: "grok",
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
});
