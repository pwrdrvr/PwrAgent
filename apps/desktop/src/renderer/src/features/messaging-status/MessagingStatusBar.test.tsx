import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingPlatformStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingStatusBar } from "./MessagingStatusBar";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessagingStatusBar", () => {
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
  });
});
