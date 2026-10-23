import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, SettingsCredentialTestResult } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ClaudeSettings } from "../ClaudeSettings";

afterEach(cleanup);

function claudeBackend(claude: NonNullable<BackendSummary["claude"]>): BackendSummary {
  return { kind: "claude", claude } as BackendSummary;
}

describe("Claude settings", () => {
  it("offers the install guide and a copyable sign-in command when Claude Code is missing", () => {
    render(<ClaudeSettings onChecked={async () => {}} backend={claudeBackend({ authStatus: "unknown" })} />);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open install guide" }))
      .toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^copy\b/i })).toBeInTheDocument();
    // Not installed is said once, by the status chip and the install field.
    expect(screen.queryByText("Claude Code", { selector: ".settings-field__label" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
  });

  it("shows no install steps before the first check", () => {
    render(<ClaudeSettings onChecked={async () => {}} />);
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open install guide" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });

  it("identifies the bundled runtime and exposes its terminal sign-in command", () => {
    render(<ClaudeSettings onChecked={async () => {}} backend={claudeBackend({
      executable: "/fixture/PwrAgent/claude", source: "bundled", version: "2.1.296",
      authStatus: "sign-in-required", loginCommand: "'/fixture/PwrAgent/claude' auth login",
    })} />);
    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
    expect(screen.getByText("Bundled with PwrAgent · 2.1.296")).toBeInTheDocument();
    expect(screen.getByText("'/fixture/PwrAgent/claude' auth login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
  });

  it("explains API billing and offers the Claude account sign-in command", () => {
    render(<ClaudeSettings onChecked={async () => {}} backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "api-key",
      loginCommand: "claude auth login",
    })} />);
    expect(screen.getByText("API key")).toBeInTheDocument();
    expect(screen.getByText(/Billed to your API key/)).toBeInTheDocument();
    expect(screen.getByText("claude auth login --claudeai")).toBeInTheDocument();
  });

  it("shows a Claude account as signed in without a billing note", () => {
    render(<ClaudeSettings onChecked={async () => {}} backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "claude-account",
    })} />);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.queryByText(/Billed to your API key/)).not.toBeInTheDocument();
    expect(screen.getByText(/does not check credits or usage limits/)).toBeInTheDocument();
  });

  it("refreshes the provider summary once per finished test, not for the remembered one", async () => {
    const remembered: SettingsCredentialTestResult = {
      kind: "claude", status: "ok", testedAt: Date.now() - 60_000, durationMs: 5, detail: "API key",
    };
    const fresh: SettingsCredentialTestResult = {
      kind: "claude", status: "ok", testedAt: Date.now() + 1_000, durationMs: 5, detail: "Claude account",
    };
    const desktopApi = {
      readLastSettingsCredentialTest: vi.fn().mockResolvedValue(remembered),
      testSettingsCredentials: vi.fn().mockResolvedValue(fresh),
    } as unknown as DesktopApi;
    const onChecked = vi.fn().mockResolvedValue(undefined);
    const backend = claudeBackend({ executable: "/fixture/claude", authStatus: "signed-in" });
    const { rerender } = render(
      <ClaudeSettings onChecked={onChecked} desktopApi={desktopApi} backend={backend} />,
    );
    expect(await screen.findByText(/API key ·/)).toBeInTheDocument();
    expect(onChecked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/Claude account ·/)).toBeInTheDocument();
    await waitFor(() => expect(onChecked).toHaveBeenCalledOnce());
    expect(desktopApi.testSettingsCredentials).toHaveBeenCalledWith({ kind: "claude" });

    // A new callback identity re-runs the test block's report effect.
    rerender(<ClaudeSettings onChecked={async () => { onChecked(); }} desktopApi={desktopApi} backend={backend} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChecked).toHaveBeenCalledOnce();
  });
});
