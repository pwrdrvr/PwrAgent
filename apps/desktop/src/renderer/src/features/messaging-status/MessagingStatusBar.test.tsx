import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingStatusBar } from "./MessagingStatusBar";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessagingStatusBar", () => {
  it("renders Feishu / Lark with the brand icon instead of the text fallback", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "feishu",
        account: "PwrAgent",
        detail: "open.larksuite.com",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    const { container } = render(<MessagingStatusBar desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Feishu \/ Lark: Enabled/),
      ).toBeInTheDocument();
    });
    expect(container.querySelector(".messaging-status-chip img")).not.toBeNull();
    expect(container.querySelector(".messaging-status-chip__fallback")).toBeNull();
  });

  it("renders degraded status with rate-limit detail in the tooltip", async () => {
    const statuses = [
      {
        changedAt: 1000,
        degradationReasons: [
          {
            expiresAt: 8000,
            key: "telegram:rate-limited:group",
            kind: "rate-limited",
            retryAfterMs: 5000,
            scope: {
              id: "telegram:group:-100123",
              kind: "group",
              label: "Telegram group -100123",
              platform: "telegram",
            },
            startedAt: 1000,
          },
        ],
        health: "degraded",
        platform: "telegram",
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    const chip = await screen.findByRole("group", {
      name: "Messaging platform status",
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Telegram: Degraded/),
      ).toBeInTheDocument();
    });
    expect(chip).toHaveTextContent("Rate limited");
    expect(chip).toHaveTextContent("Telegram group -100123");
    expect(chip).toHaveTextContent("Bot: @pwragent_bot");
    expect(chip).toHaveTextContent("Account detail: api.telegram.org");
  });

  it("clears credential identity when health event omits account metadata", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      },
    ] satisfies MessagingPlatformStatus[];
    let emitStatusEvent: ((event: MessagingPlatformStatusEvent) => void) | null =
      null;
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn((listener) => {
        emitStatusEvent = listener;
        return () => {};
      }),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    const chip = await screen.findByRole("group", {
      name: "Messaging platform status",
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Telegram: Enabled/)).toBeInTheDocument();
    });
    expect(chip).toHaveTextContent("Bot: @pwragent_bot");
    expect(chip).toHaveTextContent("Account detail: api.telegram.org");

    act(() => {
      emitStatusEvent?.({
        at: 2000,
        health: "suspended",
        kind: "health-changed",
        platform: "telegram",
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/Telegram: Suspended/)).toBeInTheDocument();
    });
    expect(chip).not.toHaveTextContent("Bot: @pwragent_bot");
    expect(chip).not.toHaveTextContent("Account detail: api.telegram.org");
  });
});
