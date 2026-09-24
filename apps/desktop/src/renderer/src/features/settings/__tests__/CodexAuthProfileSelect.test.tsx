import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  CodexAuthProfileCreateButton,
  CodexAuthProfileLoginButton,
} from "../CodexAuthProfileSelect";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

function clickFocused(name: string): void {
  const button = screen.getByRole("button", { name });
  button.focus();
  act(() => button.click());
}

describe("Create Codex profile dialog, keyboard", () => {
  function open(): HTMLElement {
    render(
      <CodexAuthProfileCreateButton
        desktopApi={{} as DesktopApi}
        existingProfiles={[]}
        onCreated={async () => undefined}
      />,
    );
    clickFocused("Create Codex profile");
    return screen.getByRole("dialog", { name: "Create Codex profile" });
  }

  it("opens with focus in the name field", () => {
    open();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Codex profile name" }),
    );
  });

  it("keeps Tab inside the dialog", () => {
    const dialog = open();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("cancels on Escape and returns focus to the button that opened it", () => {
    open();
    pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Create Codex profile" }),
    );
  });
});

describe("Log in to Codex profile dialog, keyboard", () => {
  const started = {
    profile: "work",
    codexHome: "/profiles/work/codex",
    started: true,
    authenticated: false,
  };

  function open(start: DesktopApi["startCodexAuthProfileLogin"]): HTMLElement {
    const desktopApi = {
      startCodexAuthProfileLogin: start,
      checkCodexAuthProfileStatus: vi.fn(async () => ({ authenticated: false })),
    } as unknown as DesktopApi;
    render(
      <CodexAuthProfileLoginButton
        desktopApi={desktopApi}
        displayName="work"
        profile="work"
      />,
    );
    clickFocused("Login");
    return screen.getByRole("dialog", { name: "Log in to Codex profile" });
  }

  it("takes focus on itself while every control is disabled for the login starting", () => {
    // Nothing in the dialog can take focus until the login answers, so focus
    // stayed on Login behind the scrim, and Escape and Tab went there too.
    // Not Cancel either, though it is enabled for the first render: Chromium
    // drops focus to <body> once it disables. jsdom keeps focus on a disabled
    // control, so only the dialog itself makes this assertion mean anything.
    const dialog = open(() => new Promise(() => undefined));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(document.activeElement).toBe(dialog);
  });

  it("keeps Tab inside the dialog once the login has started", async () => {
    const dialog = open(async () => ({
      ...started,
      loginUrl: "https://auth.example.test/login",
    }));
    await screen.findByRole("button", { name: "open the login link again" });
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("cancels on Escape and returns focus to Login", async () => {
    open(async () => started);
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Login" }));
  });
});
