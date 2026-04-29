import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragnt/shared";
import type { DesktopApi } from "../desktop-api";
import { useBackendSummaries } from "../useBackendSummaries";

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
});
