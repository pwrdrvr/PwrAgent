import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingErrorNotices } from "../MessagingErrorNotices";

afterEach(() => {
  cleanup();
});

describe("MessagingErrorNotices", () => {
  it("surfaces an adapter error that happened before the renderer mounted", async () => {
    const getMessagingPlatformStatuses = vi.fn(async () => [
      {
        platform: "slack",
        health: "errored",
        changedAt: 1_785_926_400_000,
        reason: "u.WebSocket is not a constructor",
      },
    ] satisfies MessagingPlatformStatus[]);

    const { container } = render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses,
          onMessagingPlatformStatusEvent: () => () => undefined,
        }}
      />,
    );

    expect(await screen.findByText("Slack messaging failed")).toBeInTheDocument();
    expect(screen.getByText(/isn't listening for messages/)).toBeInTheDocument();
    expect(screen.getByText("u.WebSocket is not a constructor")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "error");
    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();
    expect(getMessagingPlatformStatuses).toHaveBeenCalledTimes(1);
  });

  it("adds live failures and removes their notices when the platform recovers", async () => {
    let emitStatus: ((event: MessagingPlatformStatusEvent) => void) | undefined;
    const onMessagingPlatformStatusEvent = vi.fn((listener) => {
      emitStatus = listener;
      return () => undefined;
    });

    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: async () => [],
          onMessagingPlatformStatusEvent,
        }}
      />,
    );

    await waitFor(() => {
      expect(onMessagingPlatformStatusEvent).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "discord",
        health: "errored",
        at: 1_785_926_400_001,
        reason: "gateway disconnected",
      });
    });
    expect(screen.getByText("Discord messaging failed")).toBeInTheDocument();

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "discord",
        health: "enabled",
        at: 1_785_926_400_002,
      });
    });
    expect(screen.queryByText("Discord messaging failed")).not.toBeInTheDocument();
  });

  it("lets the operator acknowledge a sticky platform failure", async () => {
    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: async () => [
            {
              platform: "telegram",
              health: "errored",
              changedAt: 1_785_926_400_003,
              reason: "connection refused",
            },
          ],
          onMessagingPlatformStatusEvent: () => () => undefined,
        }}
      />,
    );

    expect(await screen.findByText("Telegram messaging failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByText("Telegram messaging failed")).not.toBeInTheDocument();
  });
});
