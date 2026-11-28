import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AcpAgentsSettings } from "../AcpAgentsSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const AUTH_ERROR =
  "json-rpc error (-32000): Authentication required: no auth method id provided";

function entry(overrides: Partial<AcpAgentSettingsEntry> = {}): AcpAgentSettingsEntry {
  return {
    backendId: "acp:grok",
    registryId: "grok",
    name: "Grok",
    authors: [],
    distributionKind: "local",
    distributionSource: "grok --acp",
    installable: false,
    installed: true,
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    activeCommand: "/Users/test/.grok/bin/grok",
    lastDiscoveryError: AUTH_ERROR,
    ...overrides,
  };
}

function accountStep(): HTMLElement {
  const step = document.querySelector<HTMLElement>('[data-step="account"]');
  if (!step) throw new Error("no account step");
  return step;
}

function readyStep(): HTMLElement {
  const step = document.querySelector<HTMLElement>('[data-step="ready"]');
  if (!step) throw new Error("no ready step");
  return step;
}

function show(getEntry: () => AcpAgentSettingsEntry) {
  const listAcpAgents = vi.fn(async () => ({
    fetchedAt: 1_000,
    entries: [getEntry()],
  }));
  const copyText = vi.fn(async () => undefined);
  // Settings shows one agent per screen, Setup first.
  render(
    <AcpAgentsSettings
      desktopApi={{ listAcpAgents, copyText } as unknown as DesktopApi}
      only={getEntry().registryId}
    />,
  );
  return { listAcpAgents, copyText };
}

describe("Grok authentication recovery", () => {
  // Rule: an authentication rejection offers sign-in for the selected binary,
  // regardless of its build channel, path, or which diagnostic field carries it.
  it("always offers sign-in for the selected runtime after an auth rejection", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("lastDiscoveryError", "lastError", "unavailableReason"),
      fc.oneof(
        fc.constantFrom(
          "/Users/test/.grok/bin/grok",
          "/Applications/PwrAgent.app/Contents/Resources/agents/grok/grok",
          "/Users/test/Custom Grok's build/grok",
        ),
        fc.array(fc.constantFrom("a", " ", "'", "$", "`"), { minLength: 1, maxLength: 20 })
          .map((parts) => `/custom/${parts.join("")}/grok`),
      ),
      async (field, activeCommand) => {
        const current = entry({ lastDiscoveryError: undefined, activeCommand, [field]: AUTH_ERROR });
        const { copyText } = show(() => current);
        try {
          expect(await screen.findByText("Sign-in required"))
            .toHaveClass("settings-card__chip--warn");
          const account = accountStep();
          expect(account).toHaveAttribute("aria-current", "step");
          expect(account).toHaveTextContent("Run this in a terminal");
          // A rejected sign-in is never Ready.
          expect(readyStep()).not.toHaveTextContent(/✓/);
          fireEvent.click(screen.getByRole("button", { name: "Copy Grok sign-in command" }));
          await waitFor(() => expect(copyText).toHaveBeenCalledWith(
            `'${activeCommand.replaceAll("'", "'\"'\"'")}' login`,
          ));
          expect(within(account).getByRole("button", { name: "Check again" })).toBeEnabled();
          // The step's Check again is the screen's only one.
          expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 12 });
  });

  it("offers sign-in when the provider explicitly reports authentication required", async () => {
    show(() => entry({ authStatus: "required", lastDiscoveryError: undefined }));
    expect(await screen.findByRole("button", { name: "Copy Grok sign-in command" }))
      .toBeInTheDocument();
  });

  it("quotes the selected Windows build for PowerShell", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
    const { copyText } = show(() => entry({ activeCommand: "C:\\Custom Grok's build\\grok.exe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy Grok sign-in command" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      "& 'C:\\Custom Grok''s build\\grok.exe' login",
    ));
  });

  it("does not prescribe Grok login for another provider's auth failure", async () => {
    show(() => entry({ registryId: "qwen", backendId: "acp:qwen", name: "Qwen Code" }));
    expect(await screen.findByText(AUTH_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Grok sign-in command" }))
      .not.toBeInTheDocument();
  });

  it("clears the sign-in guidance only after a successful recheck", async () => {
    let current = entry();
    const { listAcpAgents } = show(() => current);
    await screen.findByText("Sign-in required");
    fireEvent.click(within(accountStep()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(listAcpAgents).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Sign-in required")).toBeInTheDocument();

    current = entry({ lastDiscoveryError: undefined, lastDiscoveredAt: Date.now() });
    fireEvent.click(within(accountStep()).getByRole("button", { name: "Check again" }));
    await screen.findByText("Ready", { selector: ".settings-card__chip" });
    expect(screen.queryByRole("button", { name: "Copy Grok sign-in command" }))
      .not.toBeInTheDocument();
    expect(listAcpAgents).toHaveBeenLastCalledWith(expect.objectContaining({
      refresh: true,
      force: true,
    }));
  });

  it.each([
    "Request timed out",
    "Could not check for updates: HTTP 401 Unauthorized",
    "json-rpc error (-32000): Session not found",
  ])("preserves unrelated diagnostics: %s", async (lastDiscoveryError) => {
    show(() => entry({ lastDiscoveryError }));
    expect(await screen.findByText(lastDiscoveryError)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Grok sign-in command" }))
      .not.toBeInTheDocument();
  });
});
