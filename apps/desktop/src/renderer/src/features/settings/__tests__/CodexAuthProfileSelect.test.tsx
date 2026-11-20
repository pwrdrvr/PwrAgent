import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  CodexAuthProfileCreateButton,
  CodexAuthProfileLoginButton,
  CodexAuthProfileLoginDialog,
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

describe("Sign in to Codex again dialog", () => {
  function open() {
    const startCodexAuthProfileLogin = vi.fn(async () => ({
      profile: "work",
      codexHome: "/profiles/work/codex",
      started: false,
      authenticated: true,
      detail: "Logged in using ChatGPT",
    }));
    const onCancel = vi.fn();
    const desktopApi = {
      startCodexAuthProfileLogin,
      checkCodexAuthProfileStatus: vi.fn(async () => ({ authenticated: true })),
    } as unknown as DesktopApi;
    render(
      <CodexAuthProfileLoginDialog
        desktopApi={desktopApi}
        displayName="work"
        profile="work"
        reauthenticate
        onCancel={onCancel}
      />,
    );
    return { startCodexAuthProfileLogin, onCancel };
  }

  it("waits for the owner, because signing in again ends the current session", async () => {
    const { startCodexAuthProfileLogin, onCancel } = open();
    await act(async () => undefined);
    const dialog = screen.getByRole("dialog", { name: "Sign in to Codex again" });
    expect(dialog).toHaveTextContent("ends the current Codex session");
    expect(startCodexAuthProfileLogin).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "Cancel" }).click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(startCodexAuthProfileLogin).not.toHaveBeenCalled();
  });

  it("reports a completed sign-in as ordinary account authentication", async () => {
    const { startCodexAuthProfileLogin } = open();
    await act(async () => {
      screen.getByRole("button", { name: "Sign in again" }).click();
    });
    expect(startCodexAuthProfileLogin).toHaveBeenCalledWith({ profile: "work" });
    const dialog = screen.getByRole("dialog", { name: "Sign in to Codex again" });
    expect(dialog).toHaveTextContent("work is signed in.");
    // Codex reports no hardware-key signal for a sign-in, so none is claimed.
    expect(dialog).not.toHaveTextContent(/hardware|security key|verified/i);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});
