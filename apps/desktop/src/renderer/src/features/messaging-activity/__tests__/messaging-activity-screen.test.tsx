import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingActivityScreen } from "../MessagingActivityScreen";
import type { DesktopApi } from "../../../lib/desktop-api";

afterEach(() => {
  cleanup();
});

describe("MessagingActivityScreen", () => {
  it("shows rejected actor and guild IDs as copyable controls", async () => {
    const desktopApi = {
      listMessagingActivity: vi.fn(async () => ({
        entries: [
          {
            id: 1,
            platform: "discord",
            kind: "inbound-rejected",
            conversationId: "1480554271907905000",
            conversationTitle: "ops",
            actorId: "1177378744822943744",
            actorDisplayName: "Harold",
            summary: "Rejected inbound from Harold",
            createdAt: Date.now(),
            payload: {
              conversationKind: "channel",
              conversationParentId: "1480554271907905731",
            },
          },
        ],
      })),
    } as unknown as DesktopApi;

    render(<MessagingActivityScreen desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(desktopApi.listMessagingActivity).toHaveBeenCalledWith({ limit: 200 });
    });
    expect((await screen.findByText("1177378744822943744")).closest("button"))
      .toHaveTextContent("User ID");
    expect(screen.getByText("1480554271907905731").closest("button"))
      .toHaveTextContent("Guild ID");
    expect(screen.getByText("1480554271907905000").closest("button"))
      .toHaveTextContent("Channel ID");
  });

  it("labels Telegram topic pairing IDs with their parent supergroup", async () => {
    const desktopApi = {
      listMessagingActivity: vi.fn(async () => ({
        entries: [
          {
            id: 1,
            platform: "telegram",
            kind: "pairing",
            conversationId: "5642",
            actorId: "8460800771",
            actorDisplayName: "Harold",
            summary: "Observed pairing token",
            createdAt: Date.now(),
            payload: {
              conversationKind: "topic",
              conversationParentId: "-1003841603622",
            },
          },
        ],
      })),
    } as unknown as DesktopApi;

    render(<MessagingActivityScreen desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(desktopApi.listMessagingActivity).toHaveBeenCalledWith({ limit: 200 });
    });
    expect((await screen.findByText("8460800771")).closest("button"))
      .toHaveTextContent("Peer ID");
    expect(screen.getByText("-1003841603622").closest("button"))
      .toHaveTextContent("Supergroup ID");
    expect(screen.getByText("5642").closest("button"))
      .toHaveTextContent("Topic ID");
  });

  it("shows Slack workspace IDs from bucket metadata", async () => {
    const desktopApi = {
      listMessagingActivity: vi.fn(async () => ({
        entries: [
          {
            id: 1,
            platform: "slack",
            kind: "pairing",
            conversationId: "C079K80HTGS",
            actorId: "U079K80HTGS",
            actorDisplayName: "Harold",
            summary: "Observed pairing token",
            createdAt: Date.now(),
            payload: {
              conversationKind: "channel",
              conversationBucketId: "T079K80HTGS",
            },
          },
        ],
      })),
    } as unknown as DesktopApi;

    render(<MessagingActivityScreen desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(desktopApi.listMessagingActivity).toHaveBeenCalledWith({ limit: 200 });
    });
    expect((await screen.findByText("U079K80HTGS")).closest("button"))
      .toHaveTextContent("User ID");
    expect(screen.getByText("T079K80HTGS").closest("button"))
      .toHaveTextContent("Workspace ID");
    expect(screen.getByText("C079K80HTGS").closest("button"))
      .toHaveTextContent("Channel ID");
    const row = screen.getByText("Observed pairing token").closest("li");
    expect(row).not.toHaveTextContent("sl");
    expect(row?.querySelector("img")).toBeInTheDocument();
  });
});
