import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, UsageLimitObservation } from "@pwragent/shared";
import { ProviderStatusPanel } from "../ProviderStatusPanel";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../../lib/useBackendSummaries";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;

/** The value cell beside a label in the provider grid. */
function valueFor(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

const codexBackend: BackendSummary = {
  kind: "codex",
  label: "Codex app server",
  available: true,
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "pro",
    requiresOpenaiAuth: false,
  },
  methods: ["thread/list", "thread/read"],
  capabilities: {
    listThreads: true,
    createThread: false,
    resumeThread: true,
    renameThread: false,
    readThread: true,
    startTurn: true,
    interruptTurn: false,
    steerTurn: false,
    transcriptPagination: true,
    toolUse: false,
    approvalRequests: false,
    multiDirectoryThreads: true,
  },
  executionModes: [
    { mode: "default", label: "Default", available: true, isDefault: true },
  ],
  rateLimits: [
    { name: "5h limit", usedPercent: 15, windowMinutes: 300 },
    { name: "Weekly limit", usedPercent: 9, windowMinutes: 10_080 },
    {
      name: "Credits",
      limitId: "credits",
      windowKey: "credits",
      hasCredits: true,
      remaining: 100,
    },
  ],
};

const grokBackend: BackendSummary = {
  kind: "acp:grok",
  label: "Grok",
  available: false,
  methods: [],
  capabilities: {
    listThreads: false,
    createThread: false,
    resumeThread: false,
    renameThread: false,
    readThread: false,
    startTurn: false,
    interruptTurn: false,
    steerTurn: false,
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: false,
    multiDirectoryThreads: false,
  },
  executionModes: [],
  unavailableReason: "Grok CLI is not installed",
};

const kimiBackend: BackendSummary = {
  ...codexBackend,
  kind: "acp:kimi",
  source: "acp",
  label: "Kimi",
  account: undefined,
  rateLimits: undefined,
  acp: {
    registryId: "kimi",
    version: "0.29.2",
    distributionKinds: ["local"],
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
  },
};

const grokAcpBackend: BackendSummary = {
  ...codexBackend,
  kind: "acp:grok",
  source: "acp",
  label: "Grok",
  account: {
    type: "provider",
    label: "Grok account",
    planType: "SuperGrok Heavy",
  },
  rateLimits: [
    {
      name: "Included credits",
      usedPercent: 42.5,
    },
  ],
  acp: {
    registryId: "grok",
    version: "0.2.112",
    distributionKinds: ["local"],
    installStatus: "installed",
    authStatus: "authenticated",
    verificationStatus: "not-applicable",
  },
};

describe("ProviderStatusPanel", () => {
  it("refreshes account usage whenever the provider tab opens", () => {
    const onRefresh = vi.fn();
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh, {
      once: true,
    });

    render(<ProviderStatusPanel backends={[]} />);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("names the version and publisher of the Codex runtime in effect", () => {
    render(
      <ProviderStatusPanel
        backends={[
          {
            ...codexBackend,
            runtimeBuild: { channel: "vendor", publisher: "OpenAI" },
            serverVersion: "0.149.1",
          },
        ]}
      />,
    );

    expect(screen.getByText("0.149.1")).toBeInTheDocument();
    expect(screen.getByText("OpenAI release")).toBeInTheDocument();
  });

  it("names a PwrDrvr build rather than leaving it to the version suffix", () => {
    // `0.149.0-pwragent.2` is the only thing separating this from OpenAI's
    // 0.149.0, and a suffix alone reads as noise.
    render(
      <ProviderStatusPanel
        backends={[
          {
            ...codexBackend,
            runtimeBuild: { channel: "pwragent", publisher: "PwrDrvr" },
            serverVersion: "0.149.0-pwragent.2",
          },
        ]}
      />,
    );

    expect(screen.getByText("0.149.0-pwragent.2")).toBeInTheDocument();
    expect(screen.getByText("PwrDrvr build")).toBeInTheDocument();
  });

  it("renders account, plan, credits, and limits as rows of one grid", () => {
    render(<ProviderStatusPanel backends={[codexBackend]} />);

    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(valueFor("Account")).toHaveTextContent("user@example.com");
    // Codex sends the plan id in lowercase.
    expect(valueFor("Plan")).toHaveTextContent(/^Pro$/);
    // Credits and limits are label-column rows, not prose under the grid, and
    // read "% used" as the Usage Activity window does.
    expect(valueFor("Credits")).toHaveTextContent(/^100$/);
    expect(valueFor("5h limit")).toHaveTextContent(/^15% used/);
    expect(valueFor("Weekly limit")).toHaveTextContent(/^9% used/);
  });

  it("opens Usage Activity from the heading", () => {
    const openUsageActivity = vi.fn(async () => undefined);
    render(<ProviderStatusPanel backends={[]} desktopApi={{ openUsageActivity }} />);

    fireEvent.click(screen.getByRole("button", { name: "Usage Activity" }));

    expect(openUsageActivity).toHaveBeenCalledTimes(1);
  });

  it("projects the Codex weekly pace under its limit from the recorded history", async () => {
    const now = new Date(2026, 9, 1, 21, 35).getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Three and a half days into the week at 53%: 100% about 6.5 hours before the reset.
    const resetAt = now + 82.42 * HOUR;
    const weekly = { name: "Weekly limit", windowKey: "secondary" as const, windowMinutes: 10_080, resetAt };
    const observation: UsageLimitObservation = {
      observedAt: now, accountKey: "acct", planType: "pro",
      limits: [{ ...weekly, usedPercent: 53 }],
    };
    const readUsageActivity = vi.fn(async () => ({
      rows: [], readAt: now, rateLimits: [], truncated: false, limitObservation: observation,
    }));
    render(
      <ProviderStatusPanel
        backends={[{ ...codexBackend, rateLimits: [{ ...weekly, usedPercent: 53 }] }]}
        desktopApi={{ readUsageActivity }}
      />,
    );

    const weeklyValue = valueFor("Weekly limit");
    expect(await within(weeklyValue).findByText(/On pace to reach 100% .*, 6 h 3\d m before the reset/)).toBeInTheDocument();
    expect(weeklyValue.querySelector(".backend-status-list__pace")).toHaveClass("is-short");
    expect(readUsageActivity).toHaveBeenCalledWith({ from: now - 8 * 24 * HOUR, to: now });
  });

  it("does not read usage history when no backend has Codex limits", () => {
    const readUsageActivity = vi.fn();
    render(<ProviderStatusPanel backends={[kimiBackend]} desktopApi={{ readUsageActivity }} />);

    expect(readUsageActivity).not.toHaveBeenCalled();
  });

  it("shows the unavailable reason for an offline backend", () => {
    render(<ProviderStatusPanel backends={[grokBackend]} />);

    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("Grok CLI is not installed")).toBeInTheDocument();
  });

  it("shows ACP runtime and authentication metadata without a limits API", () => {
    render(<ProviderStatusPanel backends={[kimiBackend]} />);

    expect(screen.getByRole("heading", { name: "AI providers" })).toBeInTheDocument();
    expect(screen.getByText("0.29.2")).toBeInTheDocument();
    expect(screen.getByText("Managed by provider")).toBeInTheDocument();
  });

  it("shows Grok subscription and included-credit usage from ACP billing", () => {
    render(<ProviderStatusPanel backends={[grokAcpBackend]} />);

    // "Grok account" only repeats the provider name; Authentication carries
    // the sign-in state.
    expect(screen.queryByText("Grok account")).not.toBeInTheDocument();
    expect(valueFor("Plan")).toHaveTextContent("SuperGrok Heavy");
    expect(valueFor("Included credits")).toHaveTextContent(/^43% used/);
  });

  it("renders a backend error when status is unavailable", () => {
    render(<ProviderStatusPanel backends={[]} backendError="App servers unreachable" />);

    expect(screen.getByText("App servers unreachable")).toBeInTheDocument();
  });

  it("renders an empty state when no backends and no error", () => {
    render(<ProviderStatusPanel backends={[]} />);

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });
});
