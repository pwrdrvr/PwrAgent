import { act, renderHook } from "@testing-library/react";
import type {
  AgentEvent,
  AutomationRunArtifact,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useAutomationRunArtifact } from "../useAutomations";

function artifact(transcriptText?: string): AutomationRunArtifact {
  return {
    runId: "run-1",
    automationId: "automation-1",
    status: "running",
    actionResults: [],
    transcriptEvents: transcriptText
      ? [{
          id: "event-1",
          at: 2,
          kind: "lifecycle",
          text: transcriptText,
        }]
      : [],
    createdAt: 1,
    updatedAt: transcriptText ? 2 : 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutomationRunArtifact", () => {
  it("debounces refetches when buffered transcript events change", async () => {
    vi.useFakeTimers();
    let listener: ((event: AgentEvent) => void) | undefined;
    const getAutomationRunArtifact = vi.fn()
      .mockResolvedValueOnce({ artifact: artifact() })
      .mockResolvedValue({ artifact: artifact("Used tool: search") });
    const desktopApi = {
      getAutomationRunArtifact,
      onAgentEvent: (nextListener: (event: AgentEvent) => void) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as DesktopApi;

    const { result } = renderHook(() =>
      useAutomationRunArtifact(desktopApi, "run-1"),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAutomationRunArtifact).toHaveBeenCalledTimes(1);

    act(() => {
      listener?.({
        backend: "codex",
        notification: {
          method: "automation/run/transcript/updated",
          params: { runId: "run-1" },
        },
      });
      listener?.({
        backend: "codex",
        notification: {
          method: "automation/run/transcript/updated",
          params: { runId: "run-1" },
        },
      });
    });
    expect(getAutomationRunArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(getAutomationRunArtifact).toHaveBeenCalledTimes(2);
    expect(result.current.artifact?.transcriptEvents).toEqual([
      expect.objectContaining({ text: "Used tool: search" }),
    ]);
  });
});
