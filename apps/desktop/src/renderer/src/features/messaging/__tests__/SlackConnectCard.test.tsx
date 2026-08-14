import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { SlackConnectCard } from "../SlackConnectCard";
import { SLACK_ADMIN_APPROVAL_COPY } from "../slack-connect-copy";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SlackConnectCard", () => {
  it("opens the Slack create-from-manifest URL through desktop API", async () => {
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      oversized: false,
      manifestJson: "{}",
      opened: true,
    }));

    render(
      <SlackConnectCard
        variant="settings"
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
      />,
    );

    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeEnabled();
    expect(screen.getByText(SLACK_ADMIN_APPROVAL_COPY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Slack app" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({ open: true });
    });
  });

  it("copies the Create Slack app link for workspace owners", async () => {
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      oversized: false,
      manifestJson: "{}",
      opened: false,
    }));
    const copyText = vi.fn(async () => undefined);

    render(
      <SlackConnectCard
        variant="onboarding"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Create Slack app link" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({ open: false });
      expect(copyText).toHaveBeenCalledWith(
        "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      );
    });
  });
});
