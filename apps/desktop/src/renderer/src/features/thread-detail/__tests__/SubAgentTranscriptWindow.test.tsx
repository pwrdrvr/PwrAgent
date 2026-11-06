import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubAgentTranscriptWindow } from "../SubAgentTranscriptWindow";
import { THREAD_HISTORY_PAGE_LIMIT } from "../../../lib/thread-history-limits";

describe("SubAgentTranscriptWindow", () => {
  const originalHash = window.location.hash;

  afterEach(() => {
    delete (window as Window & { pwragent?: unknown }).pwragent;
    window.location.hash = originalHash;
    vi.restoreAllMocks();
  });

  it("reads a native Codex child directly without requiring navigation membership", async () => {
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: 123,
      threadId: "019ea380-6595-7cf0-8519-58dca9762bfb",
      threadStatus: "idle" as const,
      replay: {
        entries: [
          {
            id: "child-final-message",
            type: "message" as const,
            role: "assistant" as const,
            phase: "final" as const,
            text: "The child transcript is available.",
            createdAt: 123,
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    (window as Window & { pwragent?: unknown }).pwragent = { readThread };
    window.location.hash =
      "#sub-agent/codex/019ea380-6595-7cf0-8519-58dca9762bfb/Bacon";

    render(<SubAgentTranscriptWindow />);

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "019ea380-6595-7cf0-8519-58dca9762bfb",
        limit: THREAD_HISTORY_PAGE_LIMIT,
        viewOnly: true,
      });
    });
    expect(screen.getByRole("heading", { name: "Bacon" })).toBeInTheDocument();
    expect(screen.getByText("The child transcript is available.")).toBeInTheDocument();
  });

  it("excludes live transcript timer refreshes from request activity", async () => {
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: 123,
      threadId: "child-1",
      threadStatus: "active" as const,
      replay: {
        entries: [], messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }));
    (window as Window & { pwragent?: unknown }).pwragent = { readThread };
    window.location.hash = "#sub-agent/codex/child-1/Fixture";
    const interval = vi.spyOn(window, "setInterval");
    const view = render(<SubAgentTranscriptWindow />);
    await waitFor(() => expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_000));
    expect(readThread.mock.calls[0]).toEqual([expect.not.objectContaining({ countsAsActivity: false })]);

    const tick = interval.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    expect(typeof tick).toBe("function");
    await act(async () => { if (typeof tick === "function") tick(); });

    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({ countsAsActivity: false }));
    view.unmount();
  });

  it("reads a federated native child from the instance that owns it", async () => {
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: 123,
      threadId: "019ea380-6595-7cf0-8519-58dca9762bfb",
      threadStatus: "idle" as const,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    (window as Window & { pwragent?: unknown }).pwragent = { readThread };
    window.location.hash =
      "#sub-agent/codex/019ea380-6595-7cf0-8519-58dca9762bfb/Epicurus/pwr_remote";

    render(<SubAgentTranscriptWindow />);

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith({
        backend: "codex",
        federationTarget: {
          scope: "remote",
          instanceId: "pwr_remote",
        },
        threadId: "019ea380-6595-7cf0-8519-58dca9762bfb",
        limit: THREAD_HISTORY_PAGE_LIMIT,
        viewOnly: true,
      });
    });
  });
});
