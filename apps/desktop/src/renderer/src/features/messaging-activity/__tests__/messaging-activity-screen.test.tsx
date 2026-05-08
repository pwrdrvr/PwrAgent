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
});
