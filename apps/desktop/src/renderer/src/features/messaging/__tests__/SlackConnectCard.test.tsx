import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { SlackConnectCard } from "../SlackConnectCard";
import { SLACK_ADMIN_APPROVAL_COPY } from "../slack-connect-copy";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CHOSEN_NAME = "PwrAgent - fixture-user";

/** A card whose agent name is chosen, so the manifest actions are offered. */
const namedProps = {
  appName: { value: CHOSEN_NAME, source: "config" as const },
  onSaveAppName: async () => undefined,
};

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
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
      />,
    );

    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeEnabled();
    expect(screen.getByText(SLACK_ADMIN_APPROVAL_COPY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Slack app" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({ open: true, appName: CHOSEN_NAME });
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
        {...namedProps}
        variant="onboarding"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy link for an admin" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({ open: false, appName: CHOSEN_NAME });
      expect(copyText).toHaveBeenCalledWith(
        "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      );
    });
  });

  /**
   * The reason the manifest row exists: the clipboard is the only place the
   * manifest lives, and the rest of the task happens in a browser where the
   * operator will plausibly copy something else. Copying it back must not
   * cost a second browser tab.
   */
  it("copies the manifest without navigating, and stays repeatable", async () => {
    const openSlackCreateApp = vi.fn(async (request?: { open?: boolean }) => ({
      url: "https://api.slack.com/apps",
      oversized: false,
      manifestJson: "{\"features\":{\"agent_view\":{}}}",
      opened: request?.open === true,
    }));
    const copyText = vi.fn(async () => undefined);

    render(
      <SlackConnectCard
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({
        mode: "update",
        open: false,
        appName: CHOSEN_NAME,
      });
      expect(copyText).toHaveBeenCalledWith("{\"features\":{\"agent_view\":{}}}");
    });
    expect(
      openSlackCreateApp.mock.calls.every(([request]) => request?.open === false),
    ).toBe(true);

    // Acknowledgement lands on the pressed control, not on a paragraph
    // further down the card.
    await screen.findByRole("button", { name: "Copied" });

    // ...and the row reports the payload it just put on the clipboard.
    expect(screen.getByText(/Official PwrAgent app manifest · /)).toBeInTheDocument();

    // Repeatable while still acknowledging the first copy — the label swap
    // is why this targets the test id rather than the accessible name.
    fireEvent.click(screen.getByTestId("slack-copy-manifest"));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledTimes(2);
    });
  });

  it("reverts the copy acknowledgement after the shared reset delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps",
      oversized: false,
      manifestJson: "{}",
      opened: false,
    }));
    const copyText = vi.fn(async () => undefined);

    render(
      <SlackConnectCard
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));
    await screen.findByRole("button", { name: "Copied" });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByRole("button", { name: "Copy manifest" })).toBeInTheDocument();
  });

  it("opens Slack Apps without touching the clipboard", async () => {
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps",
      oversized: false,
      manifestJson: "{}",
      opened: true,
    }));
    const copyText = vi.fn(async () => undefined);

    render(
      <SlackConnectCard
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Slack Apps" }));

    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({
        mode: "update",
        open: true,
      });
    });
    expect(copyText).not.toHaveBeenCalled();
  });

  /**
   * A single `busy` flag rendered the pending label on whichever button
   * declared it first, so pressing the manifest action made "Create Slack
   * app" read "Opening…".
   */
  it("shows the pending label on the pressed button only", async () => {
    let release: (() => void) | undefined;
    const openSlackCreateApp = vi.fn(
      async () =>
        await new Promise<{
          url: string;
          oversized: boolean;
          manifestJson: string;
          opened: boolean;
        }>((resolve) => {
          release = () =>
            resolve({
              url: "https://api.slack.com/apps",
              oversized: false,
              manifestJson: "{}",
              opened: false,
            });
        }),
    );
    const copyText = vi.fn(async () => undefined);

    render(
      <SlackConnectCard
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp, copyText } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));

    await screen.findByRole("button", { name: "Copying…" });
    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Opening…" })).not.toBeInTheDocument();

    await act(async () => {
      release?.();
    });
  });

  it("reports a manifest copy failure beside the manifest row", async () => {
    const openSlackCreateApp = vi.fn(async () => {
      throw new Error("Refused to open an unsafe Slack app URL.");
    });

    render(
      <SlackConnectCard
        {...namedProps}
        variant="settings"
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refused to open an unsafe Slack app URL.",
    );
  });

  it("offers main's suggested name, and builds no manifest until one is chosen", async () => {
    const openSlackCreateApp = vi.fn();
    const onSaveAppName = vi.fn(async () => undefined);
    const { rerender } = render(
      <SlackConnectCard
        appName={{ value: CHOSEN_NAME, source: "default" }}
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
        variant="onboarding"
        onSaveAppName={onSaveAppName}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(CHOSEN_NAME);
    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy link for an admin" })).toBeDisabled();
    expect(
      screen.getByText("Choose the agent name first. Slack creates the app with it."),
    ).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Agent name" }), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(onSaveAppName).toHaveBeenCalledExactlyOnceWith(CHOSEN_NAME);
    });

    rerender(
      <SlackConnectCard
        appName={{ value: CHOSEN_NAME, source: "config" }}
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
        variant="onboarding"
        onSaveAppName={onSaveAppName}
      />,
    );
    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeEnabled();
    // Nothing to save until the name is edited.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("holds the manifest actions while a settings write is out", () => {
    render(
      <SlackConnectCard
        {...namedProps}
        saving
        variant="settings"
        desktopApi={{ openSlackCreateApp: vi.fn() } as unknown as DesktopApi}
      />,
    );

    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy manifest" })).toBeDisabled();
  });

  it("does not offer the existing-app manifest actions during onboarding", () => {
    render(
      <SlackConnectCard
        {...namedProps}
        variant="onboarding"
        desktopApi={{ openSlackCreateApp: vi.fn() } as unknown as DesktopApi}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Copy manifest" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Slack Apps" }),
    ).not.toBeInTheDocument();
  });
});
