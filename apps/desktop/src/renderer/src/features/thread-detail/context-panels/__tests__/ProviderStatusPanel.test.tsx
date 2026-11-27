import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";
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

/** The scope subheader a limit row sits under, if its provider has several. */
function scopeOf(row: Element): string | undefined {
  for (let node = row.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList.contains("provider-limits__scope")) return node.textContent ?? undefined;
  }
  return undefined;
}

/** A limit row, found by its window and, for a provider with several, its scope. */
function limitRow(window: string, scope?: string, within: ParentNode = document): HTMLElement {
  const rows = [...within.querySelectorAll<HTMLElement>(".provider-limits__row")]
    .filter((row) => row.dataset.window === window && scopeOf(row) === scope);
  expect(rows, `${scope ?? "(no scope)"} ${window}`).toHaveLength(1);
  return rows[0]!;
}

/** A limit row's pace line. */
function paceOf(window: string, scope?: string, within?: ParentNode): HTMLElement {
  return limitRow(window, scope, within).querySelector<HTMLElement>(".provider-limits__pace")!;
}

/** A limit row's pace line, once the usage read that draws it answers. */
async function waitForPace(window: string, scope?: string): Promise<HTMLElement> {
  await waitFor(() => expect(paceOf(window, scope)).not.toBeNull());
  return paceOf(window, scope);
}

/** The figure and reset of a limit row: its line beside the window. */
function limitValue(window: string, scope?: string, within?: ParentNode): HTMLElement {
  return limitRow(window, scope, within).querySelector<HTMLElement>(".provider-limits__stat")!;
}

const codexBackend: BackendSummary = {
  kind: "codex",
  label: "Codex app server",
  available: true,
  account: {
    type: "chatgpt",
    email: "you@example.com",
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

    // Version and build share a line.
    expect(valueFor("Version")).toHaveTextContent(/^0\.149\.1 · OpenAI release$/);
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

    expect(valueFor("Version")).toHaveTextContent(/^0\.149\.0-pwragent\.2 · PwrDrvr build$/);
  });

  it("puts facts in the grid and limits in their own block, labelled by window", () => {
    render(<ProviderStatusPanel backends={[codexBackend]} />);

    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(valueFor("Account")).toHaveTextContent("you@example.com");
    // Codex sends the plan id in lowercase; credits share the plan's line.
    expect(valueFor("Plan")).toHaveTextContent(/^Pro · 100 credits$/);
    expect(screen.queryByText("Credits", { selector: "dt" })).not.toBeInTheDocument();
    // Limits read "% used" as the Usage Activity window does, Weekly first,
    // and a single-scope provider has no scope subheader.
    expect([...document.querySelectorAll<HTMLElement>(".provider-limits__row")].map((row) => row.dataset.window))
      .toEqual(["Weekly", "5h"]);
    expect(document.querySelector(".provider-limits__scope")).toBeNull();
    expect(limitValue("Weekly")).toHaveTextContent(/^9% used/);
    expect(limitValue("5h")).toHaveTextContent(/^15% used/);
    expect(document.querySelector(".backend-status-list__metadata-grid .backend-status-list__meter")).toBeNull();
    expect(screen.queryByText(/limit/i)).not.toBeInTheDocument();
  });

  it("groups Antigravity's limits under a subheader per pool, Weekly before 5h", () => {
    const now = Date.UTC(2026, 10, 26, 14);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const antigravity: BackendSummary = {
      ...kimiBackend,
      kind: "acp:antigravity",
      label: "Antigravity",
      // As the ACP status reports them: 5h before Weekly, Gemini first.
      rateLimits: [
        { name: "5h Gemini limit", limitId: "gemini-5h", usedPercent: 2.4, resetAt: now + HOUR, windowMinutes: 300 },
        { name: "Weekly Gemini limit", limitId: "gemini-weekly", usedPercent: 31, resetAt: now + 90 * HOUR, windowMinutes: 10_080 },
        { name: "5h Claude/GPT limit", limitId: "3p-5h", usedPercent: 0, windowMinutes: 300 },
        { name: "Weekly Claude/GPT limit", limitId: "3p-weekly", usedPercent: 36, resetAt: now + 100 * HOUR, windowMinutes: 10_080 },
      ],
    };
    render(<ProviderStatusPanel backends={[antigravity]} />);

    const block = document.querySelector(".provider-limits")!;
    expect([...block.children].map((child) => child.classList.contains("provider-limits__scope")
      ? `# ${child.textContent}` : (child as HTMLElement).dataset.window)).toEqual([
      // Scopes in the shared grouping's order, the same as the gauge peek's.
      "# Gemini", "Weekly", "5h",
      "# Claude/GPT", "Weekly", "5h",
    ]);
    expect(limitValue("Weekly", "Gemini")).toHaveTextContent(/^31% used/);
    expect(limitValue("5h", "Gemini")).toHaveTextContent(/^2\.4% used/);
    expect(limitValue("Weekly", "Claude/GPT")).toHaveTextContent(/^36% used/);
    expect(block).not.toHaveTextContent(/limit/i);
    // The facts' label column is "Auth", not the longest limit name.
    expect(valueFor("Auth")).toHaveTextContent("Managed by provider");
    // Every meter is a row's own child in the block's one value column, not
    // part of a fact's value, so each starts at the same edge and runs the
    // same width (jsdom does no layout; the column structure is the guarantee).
    const meters = [...document.querySelectorAll(".backend-status-list__meter")];
    expect(meters).toHaveLength(4);
    for (const meter of meters) {
      expect(meter).toHaveClass("provider-limits__bar");
      expect(meter.parentElement).toHaveClass("provider-limits__row");
      expect(meter.parentElement!.parentElement).toBe(block);
    }
  });

  it("keeps a limit with no window, beside the provider's other limits", () => {
    const claude: BackendSummary = {
      ...codexBackend,
      kind: "claude",
      label: "Claude",
      rateLimits: [
        { name: "Weekly limit", limitId: "seven_day", usedPercent: 29, windowMinutes: 10_080 },
        { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 4, windowMinutes: 10_080 },
        { name: "Cloud session credits", limitId: "iguana_necktie", usedPercent: 3, expires: true },
      ],
    };
    render(<ProviderStatusPanel backends={[claude]} />);

    expect([...document.querySelector(".provider-limits")!.children].map((child) =>
      child.classList.contains("provider-limits__scope") ? `# ${child.textContent}` : (child as HTMLElement).dataset.window))
      .toEqual(["# All models", "Weekly", "Cloud session credits", "# Fable", "Weekly"]);
    // A long window name takes the row line rather than widening the column.
    expect(limitRow("Cloud session credits", "All models")).toHaveClass("is-long");
    expect(limitValue("Cloud session credits", "All models")).toHaveTextContent(/^3% used/);
  });

  it("opens Usage Activity from the heading", () => {
    const openUsageActivity = vi.fn(async () => undefined);
    render(<ProviderStatusPanel backends={[]} desktopApi={{ openUsageActivity }} />);

    fireEvent.click(screen.getByRole("button", { name: "Usage Activity" }));

    expect(openUsageActivity).toHaveBeenCalledTimes(1);
  });

  it("shows unavailable account and plan data instead of omitting them", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: undefined, rateLimits: undefined }]} />);
    expect(valueFor("Account")).toHaveTextContent(/^Unavailable$/);
    expect(valueFor("Plan")).toHaveTextContent(/^Unavailable$/);
  });

  it("identifies a Free plan even without an account email", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: { type: "chatgpt", planType: "free", requiresOpenaiAuth: true } }]} />);
    expect(valueFor("Account")).toHaveTextContent(/^ChatGPT account$/);
    expect(valueFor("Plan")).toHaveTextContent(/^Free · 100 credits$/);
  });

  it("keeps a credit balance off a Plan line that names no plan", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: { type: "apiKey", requiresOpenaiAuth: true } }]} />);
    expect(valueFor("Plan")).toHaveTextContent(/^API billing$/);
    expect(valueFor("Credits")).toHaveTextContent(/^100 credits$/);
  });

  it("identifies a signed-out account without implying a Free plan", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: { requiresOpenaiAuth: true }, rateLimits: undefined }]} />);
    expect(valueFor("Account")).toHaveTextContent(/^Not signed in$/);
    expect(valueFor("Plan")).toHaveTextContent(/^Not signed in$/);
  });

  it("identifies API billing instead of guessing a subscription plan", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: { type: "apiKey", requiresOpenaiAuth: true }, rateLimits: undefined }]} />);
    expect(valueFor("Account")).toHaveTextContent(/^API key$/);
    expect(valueFor("Plan")).toHaveTextContent(/^API billing$/);
  });

  it("identifies a provider that does not require OpenAI authentication", () => {
    render(<ProviderStatusPanel backends={[{ ...codexBackend, account: { requiresOpenaiAuth: false }, rateLimits: undefined }]} />);
    expect(valueFor("Account")).toHaveTextContent(/^Not required$/);
    expect(valueFor("Plan")).toHaveTextContent(/^Not required$/);
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

    // The rate leads the pace line, and running out early keeps its warning.
    const weeklyPace = await waitForPace("Weekly");
    expect(weeklyPace).toHaveTextContent(/^\+\d+(\.\d)?%\/h hits 100% .*, 6 h 3\d m before the reset$/);
    expect(weeklyPace.firstElementChild).toHaveTextContent(/^\+.*%\/h$/);
    expect(weeklyPace).toHaveClass("is-short");
    expect(readUsageActivity).toHaveBeenCalledWith({ from: now - 8 * 24 * HOUR, to: now });
  });

  it("gives each provider's sidebar rows the same trajectory as its own account window", async () => {
    const now = Date.UTC(2026, 10, 24, 21);
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Each provider's window began 48 hours ago. At constant pace, a week's
    // usage is 3.5 times the observed percentage.
    const weekly = {
      limitId: "weekly", name: "Weekly limit",
      resetAt: now + 120 * HOUR, windowMinutes: 10_080,
    };
    const claudeLimit = { ...weekly, usedPercent: 10 };
    const claudeGptLimit = { ...weekly, name: "Weekly Claude/GPT limit", usedPercent: 20 };
    const geminiLimit = { ...weekly, limitId: "gemini", name: "Weekly Gemini limit", usedPercent: 22 };
    const limitObservations: UsageLimitObservation[] = [
      { observedAt: now, provider: "anthropic", accountKey: "same-key", limits: [claudeLimit] },
      { observedAt: now, provider: "google", accountKey: "same-key", limits: [claudeGptLimit, geminiLimit] },
    ];
    const readUsageActivity = vi.fn(async () => ({
      rows: [], readAt: now, rateLimits: [], truncated: false, limitObservations,
    }));
    const claude = { ...codexBackend, kind: "claude" as const, label: "Claude", rateLimits: [claudeLimit] };
    const antigravity = {
      ...codexBackend, kind: "acp:antigravity" as const, label: "Antigravity",
      account: undefined, rateLimits: [claudeGptLimit, geminiLimit],
    };
    const backends = [claude, antigravity];
    const { rerender } = render(<ProviderStatusPanel backends={backends} desktopApi={{ readUsageActivity }} />);
    const claudeRow = screen.getByText("Claude", { selector: ".backend-status-list__name" }).closest("li")!;
    const antigravityRow = screen.getByText("Antigravity", { selector: ".backend-status-list__name" }).closest("li")!;

    expect(await within(claudeRow).findByText(/on pace for about 35%/)).toBeInTheDocument();
    expect(paceOf("Weekly", "Claude/GPT", antigravityRow)).toHaveTextContent(/on pace for about 70%/);
    expect(paceOf("Weekly", "Gemini", antigravityRow)).toHaveTextContent(/on pace for about 77%/);
    expect(readUsageActivity).toHaveBeenCalledTimes(1);

    // The status stream can advance to a new window before its usage read.
    // Never put the previous window's projection beside the new reading.
    rerender(<ProviderStatusPanel
      backends={[{ ...claude, rateLimits: [{ ...claudeLimit, resetAt: weekly.resetAt + 168 * HOUR }] }, antigravity]}
      desktopApi={{ readUsageActivity }}
    />);
    expect(within(claudeRow).queryByText(/on pace/)).not.toBeInTheDocument();
    expect(within(antigravityRow).getByText(/on pace for about 70%/)).toBeInTheDocument();

    // If live usage climbs past a cached series's projected end-of-window level
    // before the usage read refreshes, hide the contradictory stale projection.
    rerender(<ProviderStatusPanel
      backends={[{ ...claude, rateLimits: [{ ...claudeLimit, usedPercent: 45 }] }, antigravity]}
      desktopApi={{ readUsageActivity }}
    />);
    expect(within(claudeRow).queryByText(/on pace for about 35%/)).not.toBeInTheDocument();
  });

  it("paces Antigravity 5h buckets on their 300-minute window and omits reset text when absent", async () => {
    const now = Date.UTC(2026, 10, 26, 14);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const gemini5h = {
      name: "5h Gemini limit",
      limitId: "gemini-5h",
      usedPercent: 20,
      resetAt: now + 3 * HOUR,
      windowMinutes: 300,
    };
    const claude5h = {
      name: "5h Claude/GPT limit",
      limitId: "3p-5h",
      usedPercent: 0,
      windowMinutes: 300,
    };
    const geminiWeekly = {
      name: "Weekly Gemini limit",
      limitId: "gemini-weekly",
      usedPercent: 10,
      resetAt: now + 120 * HOUR,
      windowMinutes: 10_080,
    };
    const limitObservations: UsageLimitObservation[] = [
      { observedAt: now, provider: "google", limits: [gemini5h, claude5h, geminiWeekly] },
    ];
    const readUsageActivity = vi.fn(async () => ({
      rows: [], readAt: now, rateLimits: [], truncated: false, limitObservations,
    }));
    const antigravity: BackendSummary = {
      ...codexBackend,
      kind: "acp:antigravity",
      label: "Antigravity",
      account: undefined,
      rateLimits: [gemini5h, claude5h, geminiWeekly],
    };
    render(<ProviderStatusPanel backends={[antigravity]} desktopApi={{ readUsageActivity }} />);

    // 2 hours into a 5-hour window at 20% used -> +10%/h, on pace for 50% at reset.
    const gemini5hPace = await waitForPace("5h", "Gemini");
    expect(gemini5hPace).toHaveTextContent(/^\+10%\/h on pace for about 50% at the reset$/);

    // Full 5h bucket without a real reset shows 0% used with no reset or pace text.
    const claude5hRow = limitRow("5h", "Claude/GPT");
    expect(limitValue("5h", "Claude/GPT")).toHaveTextContent(/^0% used$/);
    expect(within(claude5hRow).queryByText(/resets|1970|on pace/i)).not.toBeInTheDocument();

    // Weekly bucket still uses its 10,080-minute (168h) window: 48h elapsed -> 35%.
    expect(paceOf("Weekly", "Gemini")).toHaveTextContent(/on pace for about 35%/);
  });

  it("refreshes Antigravity's projection from a newer sample at the same percentage", async () => {
    const startedAt = Date.UTC(2026, 10, 24);
    const limit = { name: "Weekly Gemini limit", usedPercent: 10, resetAt: startedAt + 168 * HOUR, windowMinutes: 10_080 };
    await fc.assert(fc.asyncProperty(fc.integer({ min: 30, max: 48 }), async (elapsedHours) => {
      const firstAt = startedAt + 16 * HOUR;
      const nextAt = startedAt + elapsedHours * HOUR;
      vi.useFakeTimers({ now: firstAt, toFake: ["Date", "setTimeout", "clearTimeout"] });
      const response = (observedAt: number) => ({
        rows: [], readAt: observedAt, rateLimits: [], truncated: false,
        limitObservations: [{ observedAt, provider: "google", limits: [limit] }],
      });
      const backend = (rateLimitsObservedAt: number): BackendSummary & { rateLimitsObservedAt: number } => ({
        ...codexBackend, kind: "acp:antigravity", label: "Antigravity", account: undefined,
        rateLimits: [limit], rateLimitsObservedAt,
      });
      const readUsageActivity = vi.fn(async () => response(firstAt));
      const view = render(<ProviderStatusPanel backends={[backend(firstAt)]} desktopApi={{ readUsageActivity }} />);
      try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText(/hits 100%/)).toBeInTheDocument();
        vi.setSystemTime(nextAt);
        readUsageActivity.mockResolvedValue(response(nextAt));
        view.rerender(<ProviderStatusPanel backends={[backend(nextAt)]} desktopApi={{ readUsageActivity }} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const expected = Math.round(10 * 168 / elapsedHours);
        expect(screen.getByText(new RegExp(`on pace for about ${expected}%`))).toBeInTheDocument();
        expect(readUsageActivity).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    }), { numRuns: 10 });
  });

  it("drops a pre-credit forecast immediately when Claude usage resets at the same deadline", async () => {
    const now = Date.UTC(2026, 10, 24, 16);
    const limit = { name: "Weekly limit", usedPercent: 10, resetAt: now + 152 * HOUR, windowMinutes: 10_080 };
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (usedPercent) => {
      vi.useFakeTimers({ now, toFake: ["Date", "setTimeout", "clearTimeout"] });
      const readUsageActivity = vi.fn(async () => ({
        rows: [], readAt: now, rateLimits: [], truncated: false,
        limitObservations: [{ observedAt: now, provider: "anthropic", limits: [limit] }],
      }));
      const backend: BackendSummary = { ...codexBackend, kind: "claude", label: "Claude", rateLimits: [limit] };
      const view = render(<ProviderStatusPanel backends={[backend]} desktopApi={{ readUsageActivity }} />);
      try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText(/hits 100%/)).toBeInTheDocument();
        view.rerender(<ProviderStatusPanel
          backends={[{ ...backend, rateLimits: [{ ...limit, usedPercent }] }]}
          desktopApi={{ readUsageActivity }}
        />);
        expect(screen.queryByText(/on pace|hits 100%/)).not.toBeInTheDocument();
        expect(limitRow("Weekly").querySelector("s")).toBeNull();
        expect(readUsageActivity).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    }), { numRuns: 10 });
  });

  it("does not read usage history when no backend has chartable limits", () => {
    const readUsageActivity = vi.fn();
    render(<ProviderStatusPanel backends={[kimiBackend]} desktopApi={{ readUsageActivity }} />);

    expect(readUsageActivity).not.toHaveBeenCalled();
  });

  it("shows the unavailable reason for an offline backend", () => {
    render(<ProviderStatusPanel backends={[grokBackend]} />);

    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toHaveClass("backend-status-list__state");
    expect(screen.getByText("Grok CLI is not installed")).toHaveClass("backend-status-list__reason");
  });

  it("names a signed-out Claude's state the way Settings does", () => {
    const reason = "Claude Code sign-in required. Sign in from Settings → AI Providers → Claude.";
    render(<ProviderStatusPanel backends={[{
      ...grokBackend,
      kind: "claude",
      label: "Claude",
      claude: {
        executable: "/Applications/PwrAgent.app/Contents/Resources/app.asar.unpacked/claude",
        source: "bundled",
        loginCommand: "'/Applications/PwrAgent.app/Contents/Resources/app.asar.unpacked/claude' auth login",
        authStatus: "sign-in-required",
        message: reason,
      },
      unavailableReason: reason,
    }]} />);

    expect(screen.getByText("Sign-in required")).toHaveClass("backend-status-list__state");
    expect(screen.getByText(reason)).toHaveClass("backend-status-list__reason");
    expect(screen.queryByText(/app\.asar\.unpacked/)).not.toBeInTheDocument();
  });

  it("labels an uninstalled or unchecked Claude the way Settings does", () => {
    const claudeBackend: BackendSummary = {
      ...grokBackend,
      kind: "claude",
      label: "Claude",
      claude: { authStatus: "unknown", message: "Install Claude Code, then sign in." },
      unavailableReason: "Install Claude Code, then sign in.",
    };
    const { rerender } = render(<ProviderStatusPanel backends={[claudeBackend]} />);

    expect(screen.getByText("Not installed")).toHaveClass("backend-status-list__state");
    expect(screen.getByText("Install Claude Code, then sign in.")).toHaveClass("backend-status-list__reason");

    rerender(<ProviderStatusPanel backends={[{ ...claudeBackend, claude: undefined, unavailableReason: undefined }]} />);
    expect(screen.getByText("Not checked")).toHaveClass("backend-status-list__state");
    expect(document.querySelector(".backend-status-list__reason")).toBeNull();
  });

  it("shows ACP runtime and authentication metadata without a limits API", () => {
    render(<ProviderStatusPanel backends={[kimiBackend]} />);

    expect(screen.getByRole("heading", { name: "AI providers" })).toBeInTheDocument();
    expect(screen.getByText("0.29.2")).toBeInTheDocument();
    expect(screen.getByText("Managed by provider")).toBeInTheDocument();
  });

  it("shows Grok subscription and included-credit usage from ACP billing", () => {
    render(<ProviderStatusPanel backends={[grokAcpBackend]} />);

    // "Grok account" only repeats the provider name; Auth carries the
    // sign-in state.
    expect(screen.queryByText("Grok account")).not.toBeInTheDocument();
    expect(valueFor("Auth")).toHaveTextContent("Signed in");
    expect(valueFor("Plan")).toHaveTextContent("SuperGrok Heavy");
    expect(limitValue("Included credits")).toHaveTextContent(/^43% used/);
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
