import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { SettingsCredentialTestResult } from "@pwragent/shared/contracts/settings";
import type { ClaudeGatewayRequest, ClaudeGatewayResponse } from "@pwragent/shared/contracts/claude-gateway";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ClaudeSettings } from "../ClaudeSettings";

afterEach(cleanup);

function claudeBackend(claude: NonNullable<BackendSummary["claude"]>): BackendSummary {
  return { kind: "claude", claude } as BackendSummary;
}

describe("Claude settings: LLM gateway sign-in", () => {
  const installed = { executable: "/fixture/claude", version: "2.1.330", gatewaySignIn: true } as const;

  it("names the gateway, relays Claude Code's questions, and re-checks once signed in", async () => {
    let finish!: (response: ClaudeGatewayResponse) => void;
    const claudeGateway = vi.fn(async (request: ClaudeGatewayRequest): Promise<ClaudeGatewayResponse> => {
      if (request.action === "start") {
        return { progress: { id: "s1", revision: 1, step: {
          state: "trust_prompt", shown: "4F:9A", shownLabel: "Certificate fingerprint (SHA-256):",
          title: "Trust gateway gateway.example.com?", confirmLabel: "Yes, trust this gateway",
        } } };
      }
      if (request.action === "wait") return await new Promise((resolve) => { finish = resolve; });
      return {};
    });
    const onChecked = vi.fn(async () => {});
    render(<ClaudeSettings onChecked={onChecked} desktopApi={{ claudeGateway } as unknown as DesktopApi}
      backend={claudeBackend({ ...installed, authStatus: "signed-in", authMethod: "claude-account" })} />);

    expect(screen.getByRole("radio", { name: "Claude account" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "LLM gateway" }));
    expect(screen.queryByRole("button", { name: "Sign in to Claude" })).not.toBeInTheDocument();
    const signIn = screen.getByRole("button", { name: "Sign in to gateway" });
    expect(signIn).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Gateway URL" }), { target: { value: "https://gateway.example.com" } });
    fireEvent.click(signIn);

    const dialog = await screen.findByRole("dialog", { name: "Trust gateway gateway.example.com?" });
    expect(claudeGateway).toHaveBeenCalledWith({ action: "start", url: "https://gateway.example.com" });
    expect(dialog).toHaveTextContent("4F:9A");
    fireEvent.click(screen.getByRole("button", { name: "Yes, trust this gateway" }));
    expect(claudeGateway).toHaveBeenCalledWith({ action: "answer", id: "s1", revision: 1 });
    expect(screen.getByRole("button", { name: "Yes, trust this gateway" })).toBeDisabled();

    await waitFor(() => expect(claudeGateway).toHaveBeenCalledWith({ action: "wait", id: "s1", after: 1 }));
    finish({ progress: { id: "s1", revision: 4, step: { state: "done" } } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChecked).toHaveBeenCalled();
  });

  it("shows the code and lets the operator reopen the page while Claude Code waits", async () => {
    const claudeGateway = vi.fn(async (request: ClaudeGatewayRequest): Promise<ClaudeGatewayResponse> => {
      if (request.action === "start") {
        return { progress: { id: "s2", revision: 2, step: {
          state: "polling", userCode: "ABCD-EFGH", browserUrl: "https://gateway.example.com/device?user_code=ABCD-EFGH",
        } } };
      }
      if (request.action === "wait") return await new Promise(() => {});
      return {};
    });
    render(<ClaudeSettings onChecked={async () => {}} desktopApi={{ claudeGateway } as unknown as DesktopApi}
      backend={claudeBackend({ ...installed, authStatus: "sign-in-required", gatewayUrl: "https://gateway.example.com" })} />);
    expect(screen.getByRole("radio", { name: "LLM gateway" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Gateway URL" })).toHaveValue("https://gateway.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to gateway" }));
    await screen.findByRole("dialog", { name: "Finish signing in in your browser" });
    expect(screen.getByLabelText("Verification code")).toHaveTextContent("ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "Open page again" }));
    expect(claudeGateway).toHaveBeenCalledWith({ action: "openBrowser", id: "s2" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(claudeGateway).toHaveBeenCalledWith({ action: "cancel", id: "s2" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks before leaving a signed-in gateway, then signs out and forgets it", async () => {
    const claudeGateway = vi.fn(async (): Promise<ClaudeGatewayResponse> => ({}));
    const onChecked = vi.fn(async () => {});
    render(<ClaudeSettings onChecked={onChecked} desktopApi={{ claudeGateway } as unknown as DesktopApi}
      backend={claudeBackend({
        ...installed, authStatus: "signed-in", authMethod: "gateway", gatewayUrl: "https://gateway.example.com",
      })} />);
    // The status chip and the field label both say Gateway.
    expect(screen.getAllByText("Gateway")).toHaveLength(2);
    expect(screen.getByText("https://gateway.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Billed by your gateway/)).toBeInTheDocument();
    expect(screen.queryByText("claude setup-token")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Claude account" }));
    const dialog = screen.getByRole("dialog", { name: "Stop using the gateway?" });
    expect(dialog).toHaveTextContent("gateway.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Stop using gateway" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(claudeGateway).toHaveBeenCalledWith({ action: "signOut", forget: true });
    expect(onChecked).toHaveBeenCalled();
  });

  it("leaves another provider's setup alone", () => {
    render(<ClaudeSettings onChecked={async () => {}} desktopApi={{ claudeGateway: vi.fn() } as unknown as DesktopApi}
      backend={claudeBackend({ ...installed, authStatus: "signed-in", authMethod: "external" })} />);
    expect(screen.getAllByText("External provider").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: "LLM gateway" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to Claude" })).not.toBeInTheDocument();
  });
});

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

  it("can start Claude Code sign-in even while the CLI reports a signed-in account", () => {
    const onSignIn = vi.fn();
    render(<ClaudeSettings onChecked={async () => {}} onSignIn={onSignIn} backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "claude-account",
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE_CODE_OAUTH_TOKEN")).toBeInTheDocument();
  });

  it("replaces the signed-in chip as soon as a turn rejects the saved login", () => {
    const backend = (authStatus: "signed-in" | "session-expired") => claudeBackend({ executable: "/fixture/claude", authStatus });
    const onChecked = async () => {};
    const { rerender } = render(<ClaudeSettings onChecked={onChecked} backend={backend("signed-in")} />);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    rerender(<ClaudeSettings onChecked={onChecked} backend={backend("session-expired")} />);
    expect(screen.getByText("Sign-in expired")).toBeInTheDocument();
    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
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
