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
  it("publishes notice changes to a shared stack without rendering duplicates", async () => {
    let emitStatus: ((event: MessagingPlatformStatusEvent) => void) | undefined;
    const onNoticeChanged = vi.fn();
    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: async () => [{
            platform: "discord",
            health: "errored",
            changedAt: 1_785_926_400_000,
            reason: "gateway disconnected",
            startupFailure: true,
          }],
          onMessagingPlatformStatusEvent: (listener) => {
            emitStatus = listener;
            return () => undefined;
          },
        }}
        onNoticeChanged={onNoticeChanged}
      />,
    );

    await waitFor(() => {
      expect(onNoticeChanged).toHaveBeenCalledWith(
        "discord",
        expect.objectContaining({ title: "Discord messaging failed" }),
      );
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const discordPublicationCount = () => onNoticeChanged.mock.calls.filter(
      ([platform]) => platform === "discord",
    ).length;
    expect(discordPublicationCount()).toBe(1);
    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "discord",
        health: "suspended",
        at: 1_785_926_400_001,
        reason: "gateway disconnected",
        startupFailure: true,
      });
    });
    await waitFor(() => {
      expect(discordPublicationCount()).toBe(1);
    });

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "discord",
        health: "errored",
        at: 1_785_926_400_002,
        reason: "bot token was revoked",
      });
    });
    await waitFor(() => {
      expect(discordPublicationCount()).toBe(2);
    });
    expect(onNoticeChanged).toHaveBeenLastCalledWith(
      "discord",
      expect.objectContaining({
        detail: "bot token was revoked",
        id: "messaging-platform-error:discord:active",
      }),
    );

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "slack",
        health: "errored",
        at: 1_785_926_400_003,
        reason: "socket disconnected",
      });
    });
    await waitFor(() => {
      expect(onNoticeChanged).toHaveBeenCalledWith(
        "slack",
        expect.objectContaining({ title: "Slack messaging failed" }),
      );
    });
    expect(discordPublicationCount()).toBe(2);

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "discord",
        health: "enabled",
        at: 1_785_926_400_004,
      });
    });
    await waitFor(() => {
      expect(onNoticeChanged).toHaveBeenLastCalledWith("discord", undefined);
    });
  });

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
    expect(screen.getByText(/Messages may be unavailable/)).toBeInTheDocument();
    expect(screen.getByText("u.WebSocket is not a constructor")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "error");
    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();
    expect(getMessagingPlatformStatuses).toHaveBeenCalledTimes(1);
  });

  it("surfaces each platform suspended by a rejected startup until recovery", async () => {
    let emitStatus: ((event: MessagingPlatformStatusEvent) => void) | undefined;
    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: async () => [
            {
              platform: "telegram",
              health: "suspended",
              changedAt: 1_785_926_400_000,
              reason: "Cannot read properties of undefined (reading 'federation')",
              startupFailure: true,
            },
            {
              platform: "discord",
              health: "suspended",
              changedAt: 1_785_926_400_001,
              reason: "Cannot read properties of undefined (reading 'federation')",
              startupFailure: true,
            },
          ],
          onMessagingPlatformStatusEvent: (listener) => {
            emitStatus = listener;
            return () => undefined;
          },
        }}
      />,
    );

    expect(await screen.findByText("Telegram messaging failed")).toBeInTheDocument();
    expect(screen.getByText("Discord messaging failed")).toBeInTheDocument();
    expect(screen.getAllByText(/could not complete messaging startup/)).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(2);

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "telegram",
        health: "enabled",
        at: 1_785_926_400_002,
      });
    });

    expect(screen.queryByText("Telegram messaging failed")).not.toBeInTheDocument();
    expect(screen.getByText("Discord messaging failed")).toBeInTheDocument();
  });

  it("does not treat an intentional suspension as a startup failure", async () => {
    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: async () => [{
            platform: "slack",
            health: "suspended",
            changedAt: 1_785_926_400_000,
            reason: "Messaging is stopped for this app instance.",
          }],
          onMessagingPlatformStatusEvent: () => () => undefined,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
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

  it("does not let an older healthy snapshot hide a newer live failure", async () => {
    let emitStatus: ((event: MessagingPlatformStatusEvent) => void) | undefined;
    let resolveSnapshot!: (statuses: MessagingPlatformStatus[]) => void;
    const snapshot = new Promise<MessagingPlatformStatus[]>((resolve) => {
      resolveSnapshot = resolve;
    });

    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: () => snapshot,
          onMessagingPlatformStatusEvent: (listener) => {
            emitStatus = listener;
            return () => undefined;
          },
        }}
      />,
    );

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "slack",
        health: "errored",
        at: 200,
        reason: "socket failed",
      });
    });
    expect(screen.getByText("Slack messaging failed")).toBeInTheDocument();

    await act(async () => {
      resolveSnapshot([{
        platform: "slack",
        health: "enabled",
        changedAt: 100,
      }]);
      await snapshot;
    });
    expect(screen.getByText("Slack messaging failed")).toBeInTheDocument();
  });

  it("does not let a stale errored snapshot resurrect a recovered notice", async () => {
    let emitStatus: ((event: MessagingPlatformStatusEvent) => void) | undefined;
    let resolveSnapshot!: (statuses: MessagingPlatformStatus[]) => void;
    const snapshot = new Promise<MessagingPlatformStatus[]>((resolve) => {
      resolveSnapshot = resolve;
    });

    render(
      <MessagingErrorNotices
        desktopApi={{
          getMessagingPlatformStatuses: () => snapshot,
          onMessagingPlatformStatusEvent: (listener) => {
            emitStatus = listener;
            return () => undefined;
          },
        }}
      />,
    );

    act(() => {
      emitStatus?.({
        kind: "health-changed",
        platform: "mattermost",
        health: "enabled",
        at: 200,
      });
    });

    await act(async () => {
      resolveSnapshot([{
        platform: "mattermost",
        health: "errored",
        changedAt: 200,
        reason: "websocket disconnected",
      }]);
      await snapshot;
    });
    expect(screen.queryByText("Mattermost messaging failed")).not.toBeInTheDocument();
  });
});
