// The director mic rides the window-level actions, so it has to follow them
// to every placement they take: the macOS/Linux sidebar masthead, the copy
// the thread header carries when the sidebar is hidden, and the Windows title
// bar. Collapsing the sidebar must not take voice away.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTitleBar } from "../../chrome/AppTitleBar";
import { MastheadActions } from "../../chrome/MastheadActions";
import type { NativeVoiceApi } from "../../../../../shared/native-voice";
import { DirectorVoiceButton } from "../DirectorVoice";

const mic = <button type="button" aria-label="Director voice" />;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", { configurable: true, value: undefined });
  delete (window as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

describe("director voice placements", () => {
  it("leads the relocated masthead the thread header shows with the sidebar hidden", () => {
    render(<MastheadActions voiceControl={mic} onToggleThreadSearch={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Director voice");
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
    expect(screen.getByRole("button", { name: "Director voice" })).toBeInTheDocument();
  });

  it("stays out of a window fronting another instance", () => {
    (window as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "sample-peer",
    };
    render(<MastheadActions voiceControl={mic} onToggleThreadSearch={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Director voice" })).not.toBeInTheDocument();
  });
});

// A bare mic says nothing about running the whole fleet, so its hover card
// names the reach and gives requests the Voice manager can actually serve.
it("describes what director voice can do on hover, and names the shortcut", () => {
  const api = {
    nativeVoiceCapability: vi.fn(), startNativeVoice: vi.fn(), stopNativeVoice: vi.fn(),
    sendNativeVoiceText: vi.fn(), onNativeVoiceEvent: () => () => {}, openVoiceManager: vi.fn(),
  } as unknown as NativeVoiceApi;
  render(<DirectorVoiceButton api={api} />);
  const button = screen.getByRole("button", { name: "Director voice" });
  fireEvent.mouseEnter(button);
  const card = screen.getByRole("tooltip");
  expect(button).toHaveAttribute("aria-describedby", card.id);
  expect(card).toHaveTextContent("Summarize the threads that need my attention");
  expect(card).toHaveTextContent("Start a thread on my Mac mini");
  expect(card).toHaveTextContent(/Space/);
});
