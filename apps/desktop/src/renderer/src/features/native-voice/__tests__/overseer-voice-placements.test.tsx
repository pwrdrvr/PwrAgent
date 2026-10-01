// The overseer mic rides the window-level actions, so it has to follow them
// to every placement they take: the macOS/Linux sidebar masthead, the copy
// the thread header carries when the sidebar is hidden, and the Windows title
// bar. Collapsing the sidebar must not take voice away.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTitleBar } from "../../chrome/AppTitleBar";
import { MastheadActions } from "../../chrome/MastheadActions";

const mic = <button type="button" aria-label="Overseer voice" />;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", { configurable: true, value: undefined });
  delete (window as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

describe("overseer voice placements", () => {
  it("leads the relocated masthead the thread header shows with the sidebar hidden", () => {
    render(<MastheadActions voiceControl={mic} onToggleThreadSearch={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Overseer voice");
  });

  it("leads the Windows title bar actions", () => {
    Object.defineProperty(window, "pwragent", { configurable: true, value: { platform: "win32" } });
    render(
      <AppTitleBar
        actions={{
          voiceControl: mic,
          automationsActive: false,
          creatingThread: false,
          onCreateThread: vi.fn(),
          onOpenAutomations: vi.fn(),
          onOpenSettings: vi.fn(),
          settingsActive: false,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Overseer voice" })).toBeInTheDocument();
  });

  it("stays out of a window fronting another instance", () => {
    (window as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "sample-peer",
    };
    render(<MastheadActions voiceControl={mic} onToggleThreadSearch={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Overseer voice" })).not.toBeInTheDocument();
  });
});
