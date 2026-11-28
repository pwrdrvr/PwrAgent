import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { SettingsCredentialTestResult } from "@pwragent/shared/contracts/settings";
import type { ClaudeGatewayRequest, ClaudeGatewayResponse } from "@pwragent/shared/contracts/claude-gateway";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ClaudeSettings } from "../ClaudeSettings";
import { ClaudeSetupChecklist } from "../HarnessSetupPanels";

afterEach(cleanup);

function claudeBackend(claude: NonNullable<BackendSummary["claude"]>): BackendSummary {
  return { kind: "claude", claude } as BackendSummary;
}

/** Setup over the runtime-and-sign-in section, as the Claude pane stacks them. */
function ClaudePane(props: {
  backend?: BackendSummary;
  desktopApi?: DesktopApi;
  onSignIn?: () => void;
  signingIn?: boolean;
  onChecked?: () => Promise<void>;
}) {
  const onChecked = props.onChecked ?? (async () => {});
  return (
    <>
      <ClaudeSetupChecklist
        backend={props.backend}
        desktopApi={props.desktopApi}
        claudeSignIn={{ onSignIn: props.onSignIn, signingIn: props.signingIn === true }}
        onChecked={onChecked}
      />
      <ClaudeSettings
        backend={props.backend}
        desktopApi={props.desktopApi}
        onSignIn={props.onSignIn}
        signingIn={props.signingIn}
        onChecked={onChecked}
      />
    </>
  );
}

function setupStep(id: string): HTMLElement {
  const step = document.querySelector<HTMLElement>(`[data-step="${id}"]`);
  if (!step) throw new Error(`no ${id} step`);
  return step;
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
    expect(screen.getByText("Gateway", { selector: ".settings-field__label > span" })).toBeInTheDocument();
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
    render(<ClaudePane desktopApi={{ claudeGateway: vi.fn() } as unknown as DesktopApi}
      backend={claudeBackend({ ...installed, authStatus: "signed-in", authMethod: "external" })} />);
    expect(screen.getByText("External provider")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open provider guide" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "LLM gateway" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
  });
});

describe("Claude settings", () => {
  it("leads with the install guide, and shows no sign-in until Claude Code is found", () => {
    render(<ClaudePane backend={claudeBackend({ authStatus: "unknown" })} />);
    // The chip and the runtime step both say it.
    expect(screen.getAllByText("Not installed")).toHaveLength(2);
    expect(setupStep("runtime")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("link", { name: "Open install guide" }))
      .toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
    expect(setupStep("account")).toHaveTextContent("Waiting for the runtime");
    expect(screen.queryByText("claude auth login")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Code", { selector: ".settings-field__label > span" })).not.toBeInTheDocument();
  });

  it("shows no install steps before the first check", () => {
    render(<ClaudePane />);
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open install guide" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
    // The runtime step offers the check, so the footer does not repeat it.
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("identifies the bundled runtime and offers its terminal sign-in command", () => {
    render(<ClaudePane backend={claudeBackend({
      executable: "/fixture/PwrAgent/claude", source: "bundled", version: "2.1.296",
      authStatus: "sign-in-required", loginCommand: "'/fixture/PwrAgent/claude' auth login",
    })} />);
    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
    expect(setupStep("runtime")).toHaveTextContent("bundled with PwrAgent");
    expect(setupStep("account")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Bundled with PwrAgent · 2.1.296")).toBeInTheDocument();
    // Said once, by Setup, which owns the sign-in while signed out.
    expect(screen.getAllByText("'/fixture/PwrAgent/claude' auth login")).toHaveLength(1);
    expect(screen.getByText("Run this in your terminal, then check again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
  });

  it("puts one browser sign-in on the account step and says it opens a browser", () => {
    const onSignIn = vi.fn();
    render(<ClaudePane onSignIn={onSignIn} backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "sign-in-required",
    })} />);
    const buttons = screen.getAllByRole("button", { name: /sign in/i });
    expect(buttons).toHaveLength(1);
    expect(setupStep("account")).toContainElement(buttons[0]!);
    expect(screen.getByText(/Opens Claude's sign-in page in your default browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("says Sign in again for an expired session, and waits truthfully while signing in", () => {
    const backend = claudeBackend({ executable: "/fixture/claude", authStatus: "session-expired" });
    const { rerender } = render(<ClaudePane onSignIn={() => {}} backend={backend} />);
    expect(screen.getAllByText("Sign-in expired").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    rerender(<ClaudePane onSignIn={() => {}} signingIn backend={backend} />);
    expect(screen.getByText("Signing in…")).toBeInTheDocument();
    expect(setupStep("account")).toHaveTextContent("Waiting for the browser");
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("explains API billing and offers the Claude account sign-in command", () => {
    render(<ClaudePane backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "api-key",
      loginCommand: "claude auth login",
    })} />);
    expect(screen.getByText("API key", { selector: ".settings-card__chip" })).toBeInTheDocument();
    expect(screen.getByText(/Billed to your API key/)).toBeInTheDocument();
    expect(screen.getByText("claude auth login --claudeai")).toBeInTheDocument();
  });

  it("shows a Claude account as ready, without claiming to check credits", () => {
    render(<ClaudePane backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "claude-account",
    })} />);
    expect(screen.getAllByText("Signed in").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Billed to your API key/)).not.toBeInTheDocument();
    expect(setupStep("ready")).toHaveTextContent("credits and usage limits are not");
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it("can start Claude Code sign-in even while the CLI reports a signed-in account", () => {
    const onSignIn = vi.fn();
    render(<ClaudePane onSignIn={onSignIn} backend={claudeBackend({
      executable: "/fixture/claude", authStatus: "signed-in", authMethod: "claude-account",
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE_CODE_OAUTH_TOKEN")).toBeInTheDocument();
  });

  it("replaces the signed-in chip as soon as a turn rejects the saved login", () => {
    const backend = (authStatus: "signed-in" | "session-expired") => claudeBackend({ executable: "/fixture/claude", authStatus });
    const { rerender } = render(<ClaudePane backend={backend("signed-in")} />);
    expect(screen.getAllByText("Signed in").length).toBeGreaterThan(0);
    rerender(<ClaudePane backend={backend("session-expired")} />);
    expect(screen.getAllByText("Sign-in expired").length).toBeGreaterThan(0);
    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
  });

  it("refreshes the provider summary once per finished check, not for the remembered one", async () => {
    const remembered: SettingsCredentialTestResult = {
      kind: "claude", status: "ok", testedAt: Date.now() - 120_000, durationMs: 5, detail: "API key",
    };
    const fresh: SettingsCredentialTestResult = {
      kind: "claude", status: "ok", testedAt: Date.now(), durationMs: 5, detail: "Claude account",
    };
    const desktopApi = {
      readLastSettingsCredentialTest: vi.fn().mockResolvedValue(remembered),
      testSettingsCredentials: vi.fn().mockResolvedValue(fresh),
    } as unknown as DesktopApi;
    const onChecked = vi.fn().mockResolvedValue(undefined);
    const backend = claudeBackend({ executable: "/fixture/claude", authStatus: "signed-in" });
    const { rerender } = render(<ClaudePane onChecked={onChecked} desktopApi={desktopApi} backend={backend} />);
    expect(await screen.findByText("Checked 2m ago")).toBeInTheDocument();
    expect(onChecked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Checked just now")).toBeInTheDocument();
    await waitFor(() => expect(onChecked).toHaveBeenCalledOnce());
    expect(desktopApi.testSettingsCredentials).toHaveBeenCalledWith({ kind: "claude" });

    rerender(<ClaudePane onChecked={async () => { onChecked(); }} desktopApi={desktopApi} backend={backend} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChecked).toHaveBeenCalledOnce();
  });
});
