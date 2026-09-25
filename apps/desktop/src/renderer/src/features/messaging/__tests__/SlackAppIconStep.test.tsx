import "@testing-library/jest-dom/vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { SlackAppIconStep } from "../SlackAppIconStep";

afterEach(() => {
  cleanup();
});

describe("SlackAppIconStep", () => {
  /**
   * Chromium's own image drag carries a renderer URL, which a browser upload
   * field cannot take. The step hands the drag to main, which puts the file
   * on the OS pasteboard.
   */
  it("hands the icon drag to main instead of Chromium's image drag", () => {
    const startAppIconDrag = vi.fn();
    render(
      <SlackAppIconStep
        variant="settings"
        desktopApi={{ startAppIconDrag } as unknown as DesktopApi}
      />,
    );

    const icon = screen.getByRole("img", { name: "PwrAgent app icon" });
    expect(icon).toHaveAttribute("draggable", "true");
    const dragStart = createEvent.dragStart(icon);
    fireEvent(icon, dragStart);

    expect(dragStart.defaultPrevented).toBe(true);
    expect(startAppIconDrag).toHaveBeenCalledTimes(1);
  });

  it("opens the app's Basic Information page without a status line", async () => {
    const openSlackAppSettings = vi.fn(async () => ({
      url: "https://api.slack.com/apps/A0FAKEAPP01/general",
      appSpecific: true,
    }));
    render(
      <SlackAppIconStep
        variant="settings"
        desktopApi={{ openSlackAppSettings } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Basic Information" }));

    await vi.waitFor(() => {
      expect(openSlackAppSettings).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says where to go when no App Token names the app yet", async () => {
    const openSlackAppSettings = vi.fn(async () => ({
      url: "https://api.slack.com/apps",
      appSpecific: false,
    }));
    render(
      <SlackAppIconStep
        variant="settings"
        desktopApi={{ openSlackAppSettings } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Basic Information" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Choose the PwrAgent app, then Basic Information.",
    );
  });

  it("offers no drag where main cannot start one", () => {
    render(<SlackAppIconStep variant="settings" desktopApi={{} as unknown as DesktopApi} />);

    expect(screen.getByRole("img", { name: "PwrAgent app icon" })).toHaveAttribute(
      "draggable",
      "false",
    );
    expect(screen.getByRole("button", { name: "Open Basic Information" })).toBeDisabled();
  });
});
