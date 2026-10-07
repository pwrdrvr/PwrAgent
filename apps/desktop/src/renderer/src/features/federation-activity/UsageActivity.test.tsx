import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackendSummary, DesktopSettingsConfigPatch, DesktopSettingsWriteResponse, ListBackendsResponse,
  ReadDesktopSettingsResponse, ReadFederationActivityResponse, UsageLimitObservation } from "@pwragent/shared";
import { UsageActivity } from "./UsageActivity";
import { usageFixture } from "./usage-activity-fixture";
import { chooseSelectOption, selectListbox, selectOptionLabels } from "../../test/select";

const HOUR = 3_600_000;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function choosePeriod(label: string) {
  fireEvent.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: label }));
}

function chooseCustomRange(from: string, to: string) {
  choosePeriod("Custom");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
}

const peers = (list: Array<{ id: string; label: string; status: string; profileName?: string }>) =>
  vi.fn(async () => ({ health: { localLabel: "Local", peers: list } }) as ReadFederationActivityResponse);

it("reads on open, skips offline peers, names outdated ones, and analyzes the selected turn on its owner", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const readUsageActivity = vi.fn(async (request) => {
    if (request.federationTarget?.instanceId === "old") {
      throw new Error("Error invoking remote method 'usage-activity:readUsageActivity': Error: method_not_found: No federation handler registered for backend.readUsageActivity");
    }
    return { rows: request.federationTarget?.scope === "local" ? []
      : [usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR })],
    readAt: now, rateLimits: [], truncated: false };
  });
  const analyzeUsageActivity = vi.fn(async () => ({ analysis: "A bounded diagnosis.", model: "gpt-6-luna", entries: 4, characters: 8000,
    truncated: true, hasEarlierHistory: true, scope: "turn" as const, pagesRead: 1 }));
  const readFederationActivity = peers([
    { id: "owner", label: "Owner", status: "connected" },
    { id: "old", label: "Old", status: "connected" },
    { id: "offline", label: "Offline", status: "disconnected" },
  ]);
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity, readFederationActivity }} />);
  expect(await screen.findByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  // Discovery settles before the first read, so peers are read once, and an offline peer not at all.
  expect(readUsageActivity).toHaveBeenCalledTimes(3);
  expect(readUsageActivity).not.toHaveBeenCalledWith(expect.objectContaining({ federationTarget: { scope: "remote", instanceId: "offline" } }));
  expect(screen.getByRole("button", { name: "Offline" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Not included: Old needs a PwrAgent update to share usage · Offline is offline.");
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByText(/Not included/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Inspect Fixture thread" }));
  expect(screen.getByText(/This is a model call of its own, and it uses your limit/)).toBeInTheDocument();
  // Settle the analysis and its automatic tab selection before clicking Details.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  });
  await screen.findByText("A bounded diagnosis.");
  expect(screen.getByRole("button", { name: "Analyze turn again" })).toBeEnabled();
  // An analyzed turn splits the inspector, landing on its answer.
  expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  expect(screen.getByRole("group", { name: "Turns in window" })).toBeInTheDocument();
  expect(screen.queryByText("A bounded diagnosis.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "turn",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });

  fireEvent.click(within(screen.getByRole("group", { name: "Analysis scope" })).getByRole("button", { name: "Recent entries" }));
  fireEvent.click(screen.getByRole("button", { name: "Analyze thread" }));
  await waitFor(() => expect(analyzeUsageActivity).toHaveBeenCalledTimes(2));
  expect(analyzeUsageActivity).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });
});

it("offers the owner's Grok models by agent and sends the one chosen, only to an owner that runs them", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const row = usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR });
  const backend = (kind: string, label: string, available: boolean, models: Array<{ id: string; label: string }>) =>
    ({ kind, label, available, launchpadOptions: { models } }) as unknown as BackendSummary;
  const listBackends = vi.fn(async () => ({ backends: [
    backend("codex", "Codex", true, [{ id: "gpt-6-luna", label: "GPT-6-Luna" }, { id: "gpt-6", label: "GPT-6" }]),
    backend("acp:grok", "Grok", true, [{ id: "grok-4.7", label: "Grok 4.7" }, { id: "grok-4.7-build-fast", label: "Grok 4.7 Fast" }]),
    backend("acp:kimi", "Kimi Code", true, [{ id: "k3", label: "K3" }]),
  ] }) as unknown as ListBackendsResponse);
  let owner: "current" | "older" = "current";
  const readUsageActivity = vi.fn(async () => ({ rows: [row], readAt: now, rateLimits: [], truncated: false,
    ...owner === "current" ? { analysisModelBackends: ["codex" as const, "acp:grok" as const] } : {} }));
  const analyzeUsageActivity = vi.fn(async () => ({ analysis: "Grok's diagnosis.", model: "grok-4.7", entries: 4, characters: 8000,
    truncated: false, hasEarlierHistory: false, scope: "turn" as const, pagesRead: 1, modelBackend: "acp:grok" as const }));
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity, listBackends }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Fixture thread" }));
  const picker = screen.getByRole("combobox", { name: "Model" });
  await waitFor(() => expect(selectOptionLabels(picker)).toContain("Grok 4.7"));
  // Codex first, then each agent the owner runs; an agent it cannot run is not offered.
  expect(selectOptionLabels(picker)).toEqual(["GPT-6-Luna", "GPT-6", "Grok 4.7", "Grok 4.7 Fast"]);
  fireEvent.click(picker);
  expect(within(selectListbox(picker)).getByRole("option", { name: /^Grok 4\.7 Fast/ })).toHaveTextContent("Grok");
  fireEvent.click(picker);
  expect(screen.getByText(/The model reads only this excerpt and gets no tools\./)).toBeInTheDocument();

  chooseSelectOption(picker, /^Grok 4\.7(?! Fast)/);
  fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  await screen.findByText("Grok's diagnosis.");
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "turn",
    federationTarget: { scope: "local" }, model: "grok-4.7", modelBackend: "acp:grok", entryLimit: 40, characterLimit: 20000 });

  // An owner that predates the field lists no backends, so Grok is not offered
  // and the choice returns to the default.
  owner = "older";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(selectOptionLabels(screen.getByRole("combobox", { name: "Model" }))).toEqual(["GPT-6-Luna", "GPT-6"]));
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("GPT-6-Luna");
});

it("keeps the list usable while an analysis runs, and keeps its answer with the turn it read", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const rows = ["first", "second"].map((id, index) => ({ ...usageFixture({ threadId: id, usageLineId: id, turnId: `${id}-turn`,
    createdAt: now - 3 * HOUR, startedAt: now - 3 * HOUR, completedAt: now - HOUR, totalCostMicros: (2 - index) * 1_000_000 }), title: `${id} thread` }));
  let fail!: (cause: Error) => void;
  const analyzeUsageActivity = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
  const readUsageActivity = vi.fn(async () => ({ rows, readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect first thread" }));
  fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  expect(screen.getByText(/Reading on This instance and asking GPT-6-Luna · 0 s/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyzing…" })).toBeDisabled();

  // Other threads stay open to inspection; only a second analysis waits.
  fireEvent.click(screen.getByRole("button", { name: "Inspect second thread" }));
  expect(screen.getByText("Another thread's analysis is still running.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyze turn" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

  await act(async () => { fail(new Error("Error invoking remote method 'usage-activity:analyzeUsageActivity': Error: turn_control permission required")); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyze turn" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect first thread" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Analysis failedturn_control permission required");
});

it("warns when the pace reaches the limit before its reset and draws that ahead of now", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  // Four days into the week at 80%: 100% a day from now, two days before the reset.
  const observation: UsageLimitObservation = { observedAt: now, accountKey: "acct", planType: "plus",
    limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent: 80, resetAt: now + 3 * 24 * HOUR, windowMinutes: 10_080 }] };
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false, limitObservation: observation }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(await screen.findByText(/On pace to reach 100% .*, 2 days before the reset/)).toBeInTheDocument();
  expect(screen.getByText("At this pace")).toBeInTheDocument();
  expect(screen.getByText("Now")).toBeInTheDocument();
  // The reset lies past the 40% cap; the 100% crossing a day out is inside it.
  expect(screen.getByText(/^100% /)).toBeInTheDocument();
  expect(screen.queryByText(/^Resets /)).not.toBeInTheDocument();

  // A clock window is history only.
  choosePeriod("7 days");
  await waitFor(() => expect(screen.queryByText("Now")).not.toBeInTheDocument());
  expect(screen.getByText(/On pace to reach 100%/)).toBeInTheDocument();
});

it("stacks spend by model, provider or instance, and narrows the threads to one", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const turn = (id: string, extra: Record<string, unknown>) => ({ ...usageFixture({ threadId: id, usageLineId: id,
    createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR, ...extra }), title: `${id} thread` });
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    rows: request.federationTarget?.scope === "local"
      ? [turn("codex", { model: "gpt-6", modelLabel: "GPT-6", totalCostMicros: 2_000_000 })]
      : [turn("grok", { backend: "acp:grok", provider: "xai", model: "grok-5", modelLabel: "Grok 5", totalCostMicros: 1_000_000 })] }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "owner", label: "Owner", status: "connected" }]) }} />);
  await screen.findByRole("button", { name: "Inspect grok thread" });
  const spendBy = screen.getByRole("group", { name: "Spend by" });
  expect(within(spendBy).getAllByRole("button").map((button) => button.textContent)).toEqual(["Thread", "Model", "Provider", "Account", "Instance"]);

  fireEvent.click(within(spendBy).getByRole("button", { name: "Provider" }));
  expect(screen.getByRole("button", { name: /^OpenAI · \$2\.00$/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^xAI · \$1\.00$/ }));
  expect(screen.getByText("Provider: xAI")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect codex thread" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect grok thread" })).toBeInTheDocument();

  // Another dimension drops the filter.
  fireEvent.click(within(spendBy).getByRole("button", { name: "Instance" }));
  expect(screen.getByRole("button", { name: "Inspect codex thread" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Owner · \$1\.00$/ })).toBeInTheDocument();
  fireEvent.click(within(spendBy).getByRole("button", { name: "Model" }));
  expect(screen.getByRole("button", { name: /^Grok 5 · \$1\.00$/ })).toBeInTheDocument();
});

it("filters totals, tokens, limits and threads by recorded account across owners and account switches", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const row = (id: string, accountKey: string | undefined, cost: number, provider = "openai") => ({
    ...usageFixture({ threadId: id, turnId: `${id}-turn`, usageLineId: id, provider,
      createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR, totalCostMicros: cost * 1_000_000 }),
    title: id, accountKey,
  });
  const old = row("Previous login", "alpha", 1);
  const observation = (accountKey: string): UsageLimitObservation => ({ observedAt: now, accountKey, limits: [] });
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    ...request.federationTarget?.scope === "local" ? {
      rows: [old, row("Current login", "beta", 2), row("Unkeyed history", undefined, 3),
        { ...old, accountKey: undefined, line: { ...old.line, scope: "monitor" as const, totalCostMicros: 10_000_000 } }],
      limitObservation: observation("beta"), limitHistory: [observation("alpha")],
    } : { rows: [row("Same account abroad", "alpha", 4), row("Another provider", "alpha", 5, "xai")],
      limitObservation: observation("alpha") } }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "remote", label: "Remote", status: "connected" }]) }} />);
  await screen.findByRole("button", { name: "Inspect Current login" });
  choosePeriod("7 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(4));
  const band = () => within(screen.getByRole("region", { name: "Limits and cost" }));
  expect(band().getByText("$15.00")).toBeInTheDocument();
  const picker = screen.getByRole("combobox", { name: "Account" });
  expect(selectOptionLabels(picker)).toEqual([
    "All accounts", "OpenAI · Local", "OpenAI · Local +1", "xAI", "No account recorded · Local",
  ]);
  const spendBy = screen.getByRole("group", { name: "Spend by" });
  fireEvent.click(within(spendBy).getByRole("button", { name: "Provider" }));
  expect(screen.getByRole("button", { name: /^OpenAI · \$10\.00$/ })).toBeInTheDocument();
  fireEvent.click(within(spendBy).getByRole("button", { name: "Account" }));
  expect(screen.getByRole("button", { name: /^OpenAI · Local \+1 · \$5\.00$/ })).toHaveAttribute("data-tooltip",
    "Show only OpenAI · Local +1: limits, spend and threads");
  fireEvent.click(screen.getByRole("button", { name: /^OpenAI · Local \+1 · \$5\.00$/ }));
  expect(picker).toHaveTextContent("OpenAI · Local +1");
  expect(screen.getByRole("group", { name: "Account scope" })).toHaveTextContent(
    "Showing OpenAI · Local +1 · Local, Remote. Limits, spend, chart and threads are this account only.");
  expect(band().getByText("$5.00")).toBeInTheDocument();
  expect(band().getByText("2 threads · 2 turns")).toBeInTheDocument();
  expect(band().getByText("600")).toBeInTheDocument();
  expect(band().getByText("400")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Previous login" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Same account abroad" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Current login" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Another provider" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Inspect Previous login" }));
  chooseSelectOption(picker, "OpenAI · Local");
  expect(band().getByText("$2.00")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Turns in window" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Current login" })).toBeInTheDocument();
  chooseSelectOption(picker, "No account recorded · Local");
  expect(band().getByText("$3.00")).toBeInTheDocument();
  expect(screen.getByText(/No account was recorded for these turns/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Unkeyed history" })).toBeInTheDocument();
  chooseSelectOption(picker, "All accounts");
  expect(band().getByText("$15.00")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Account scope" })).not.toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(4); // Clock-period account filtering stays local.
});

it("focuses an account's turns and helper costs without any limit reading", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const row = (id: string, accountKey: string, cost: number, helper = false) => ({
    ...usageFixture({ threadId: id, turnId: helper ? undefined : `${id}-turn`, usageLineId: id,
      scope: helper ? "monitor" as const : "turn" as const,
      createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR,
      totalCostMicros: cost * 1_000_000 }),
    title: id, accountKey,
    ...(helper ? { rollup: { kind: "title-helper", count: 2, groupKey: id } } : {}),
  });
  const readUsageActivity = vi.fn(async () => ({ readAt: now, rateLimits: [], truncated: false,
    rows: [row("Account A turn", "alpha", 1), row("Account A helpers", "alpha", 2, true), row("Account B turn", "beta", 4)] }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  await screen.findByRole("button", { name: "Inspect Account B turn" });
  choosePeriod("7 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(2));
  chooseSelectOption(screen.getByRole("combobox", { name: "Account" }), "OpenAI · This instance · alph");
  expect(within(screen.getByRole("region", { name: "Limits and cost" })).getByText("$3.00")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Account A helpers" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Account B turn" })).not.toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(2);
});

it("reads ten federated profiles, sums their provider usage and selects an account outside the five chart series", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  let activeReads = 0;
  let peakReads = 0;
  const readUsageActivity = vi.fn(async (request) => {
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    await Promise.resolve();
    activeReads -= 1;
    const index = request.federationTarget.scope === "local" ? 0 : Number(request.federationTarget.instanceId.slice("machine-".length));
    const accountKey = `acct-${index}`;
    return { readAt: now, rateLimits: [], truncated: false,
      rows: [{ ...usageFixture({ threadId: `thread-${index}`, turnId: `turn-${index}`, usageLineId: `line-${index}`,
        createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR, totalCostMicros: (index + 1) * 1_000_000 }),
      title: `Account ${index} work`, accountKey }],
      limitObservation: { observedAt: now, accountKey, limits: [] } };
  });
  const remoteProfiles = Array.from({ length: 9 }, (_, offset) => ({ id: `machine-${offset + 1}`,
    label: `Machine ${offset + 1}`, profileName: `profile-${offset + 1}`, status: "connected" }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers(remoteProfiles) }} />);
  await screen.findByRole("button", { name: "Inspect Account 9 work" });
  expect(readUsageActivity).toHaveBeenCalledTimes(10);
  expect(new Set(readUsageActivity.mock.calls.map(([request]) => request.federationTarget.instanceId ?? "local")).size).toBe(10);
  expect(peakReads).toBe(4);
  const band = () => within(screen.getByRole("region", { name: "Limits and cost" }));
  expect(band().getByText("$55.00")).toBeInTheDocument();
  expect(band().getByText("10 threads · 10 turns")).toBeInTheDocument();
  const picker = screen.getByRole("combobox", { name: "Account" });
  expect(selectOptionLabels(picker)).toHaveLength(11); // All accounts, plus each of the ten accounts.
  expect(selectOptionLabels(picker)).toContain("OpenAI · Machine 9 (profile-9)");
  const spendBy = screen.getByRole("group", { name: "Spend by" });
  fireEvent.click(within(spendBy).getByRole("button", { name: "Provider" }));
  expect(screen.getByRole("button", { name: /^OpenAI · \$55\.00$/ })).toBeInTheDocument();
  fireEvent.click(within(spendBy).getByRole("button", { name: "Account" }));
  expect(screen.getByText("Other accounts")).toBeInTheDocument();
  chooseSelectOption(picker, "OpenAI · Local");
  expect(band().getByText("$1.00")).toBeInTheDocument();
  expect(band().getByText("1 thread · 1 turn")).toBeInTheDocument();
  expect(band().getByText("300")).toBeInTheDocument();
  expect(band().getByText("200")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Account 0 work" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Account 9 work" })).not.toBeInTheDocument();
  chooseSelectOption(picker, "All accounts");
  expect(band().getByText("$55.00")).toBeInTheDocument();
  expect(band().getByText("10 threads · 10 turns")).toBeInTheDocument();
});

it("keeps a mixed-version ledger copy in its recorded account when the unkeyed peer is read first", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const row = usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR,
    completedAt: now - HOUR, totalCostMicros: 5_000_000 });
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    ...request.federationTarget?.scope === "local" ? { rows: [row] } : {
      rows: [{ ...row, accountKey: "recorded" }],
      limitObservation: { observedAt: now, accountKey: "current", limits: [] },
      limitHistory: [{ observedAt: now - HOUR, accountKey: "recorded", limits: [] }],
    } }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "remote", label: "Remote", status: "connected" }]) }} />);
  await screen.findByRole("button", { name: "Inspect Fixture thread" });
  choosePeriod("7 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(4));
  const picker = screen.getByRole("combobox", { name: "Account" });
  chooseSelectOption(picker, "OpenAI · Local +1");
  const band = within(screen.getByRole("region", { name: "Limits and cost" }));
  expect(band.getByText("$5.00")).toBeInTheDocument();
  expect(band.getByText("1 thread · 1 turn")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  expect(selectOptionLabels(picker).some((label) => label.includes("No account recorded"))).toBe(false);
  expect(readUsageActivity).toHaveBeenCalledTimes(4);
});

it("uses the selected account's reset window rather than another instance's current account", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const reading = (accountKey: string, daysSinceReset: number): UsageLimitObservation => ({
    observedAt: now, accountKey, limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent: 20,
      resetAt: now + (7 - daysSinceReset) * 24 * HOUR, windowMinutes: 10_080 }],
  });
  const readUsageActivity = vi.fn(async (request) => ({ rows: [], readAt: now, rateLimits: [], truncated: false,
    limitObservation: request.federationTarget?.scope === "local" ? reading("local-account", 4) : reading("remote-account", 2) }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "remote", label: "Remote", status: "connected" }]) }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  await screen.findByRole("combobox", { name: "Account" });
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(4));
  chooseSelectOption(screen.getByRole("combobox", { name: "Account" }), "OpenAI · Remote");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(6));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  expect(readUsageActivity.mock.calls.slice(-2).map(([request]) => request.from)).toEqual([now - 2 * 24 * HOUR, now - 2 * 24 * HOUR]);
  expect(screen.queryByText(/Limits are the newest reading, from Local/)).not.toBeInTheDocument();
  expect(screen.getByText(/Limits are the newest reading, from Remote/)).toBeInTheDocument();
});

it("names an account on this machine, from the scope line, without undoing another window's names", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const row = (id: string, accountKey: string, cost: number) => ({
    ...usageFixture({ threadId: id, turnId: `${id}-turn`, usageLineId: id,
      createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR, totalCostMicros: cost * 1_000_000 }),
    title: id, accountKey,
  });
  let stored: Record<string, string> = {};
  const settings = () => ({ snapshot: { models: { usageAccountNames: { ...stored } } } }) as unknown as ReadDesktopSettingsResponse;
  const readSettings = vi.fn(async () => settings());
  const writeSettingsConfig = vi.fn(async ({ patch }: { patch: DesktopSettingsConfigPatch }) => {
    stored = patch.models!.usageAccountNames!;
    return settings() as unknown as DesktopSettingsWriteResponse;
  });
  const readUsageActivity = vi.fn(async () => ({ readAt: now, rateLimits: [], truncated: false,
    rows: [row("Work thread", "work", 2), row("Home thread", "home", 1)],
    limitObservation: { observedAt: now, accountKey: "home", planType: "plus", limits: [] } }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readSettings, writeSettingsConfig }} />);
  await screen.findByRole("button", { name: "Inspect Home thread" });
  // Mixed rows say which account they ran on.
  expect(within(screen.getByRole("button", { name: "Inspect Home thread" })).getByText("This instance · Unknown model · OpenAI Plus")).toBeInTheDocument();
  expect(within(screen.getByRole("button", { name: "Inspect Work thread" })).getByText("This instance · Unknown model · OpenAI")).toBeInTheDocument();
  const picker = screen.getByRole("combobox", { name: "Account" });
  expect(selectOptionLabels(picker)).toEqual(["All accounts", "OpenAI", "OpenAI Plus"]);
  chooseSelectOption(picker, "OpenAI Plus");
  // Since reset follows the selected account's window, so selecting rereads once; naming never does.
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  const scope = () => screen.getByRole("group", { name: "Account scope" });
  expect(scope()).toHaveTextContent("Showing OpenAI Plus · This instance. Limits, spend, chart and threads are this account only.");
  expect(screen.getByRole("button", { name: "Inspect Home thread" })).not.toHaveTextContent("OpenAI Plus");

  stored = { "openai:elsewhere": "Named in another window" };
  fireEvent.click(within(scope()).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(scope()).getByRole("textbox", { name: "Account name" }), { target: { value: " Home " } });
  fireEvent.click(within(scope()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(picker).toHaveTextContent("Home"));
  expect(writeSettingsConfig).toHaveBeenLastCalledWith({ patch: { models: { usageAccountNames: {
    "openai:elsewhere": "Named in another window", "openai:home": "Home" } } } });
  expect(scope()).toHaveTextContent("Showing Home · OpenAI Plus · This instance.");
  expect(within(screen.getByRole("region", { name: "Limits and cost" })).getByText("$1.00")).toBeInTheDocument();

  // Blank returns the derived name.
  fireEvent.click(within(scope()).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(scope()).getByRole("textbox", { name: "Account name" }), { target: { value: "" } });
  fireEvent.click(within(scope()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(picker).toHaveTextContent("OpenAI Plus"));
  expect(stored).toEqual({ "openai:elsewhere": "Named in another window" });
  expect(readUsageActivity).toHaveBeenCalledTimes(2);
});

it("offers Spend by Account only when the period has more than one account", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const readUsageActivity = vi.fn(async () => ({ readAt: now, rateLimits: [], truncated: false,
    rows: [{ ...usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR }), accountKey: "only" }] }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  await screen.findByRole("button", { name: "Inspect Fixture thread" });
  expect(within(screen.getByRole("group", { name: "Spend by" })).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["Thread", "Model", "Provider"]);
  expect(screen.getByRole("button", { name: "Inspect Fixture thread" })).not.toHaveTextContent("OpenAI");
});

it("keeps a historical account selected when the new period has no usage for it", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const previous = { ...usageFixture({ threadId: "previous", turnId: "old-turn", usageLineId: "old-line",
    createdAt: now - 48 * HOUR, startedAt: now - 48 * HOUR, completedAt: now - 47 * HOUR, totalCostMicros: 1_000_000 }),
  accountKey: "previous", title: "Previous account" };
  const current = { ...usageFixture({ threadId: "current", turnId: "new-turn", usageLineId: "new-line",
    createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR, totalCostMicros: 9_000_000 }),
  accountKey: "current", title: "Current account" };
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    rows: request.from < previous.line.completedAt! ? [previous, current] : [current],
    limitObservation: { observedAt: now, accountKey: "current", limits: [] } }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  await screen.findByRole("button", { name: "Inspect Previous account" });
  chooseSelectOption(screen.getByRole("combobox", { name: "Account" }), "OpenAI · This instance · prev");
  choosePeriod("Today");
  await waitFor(() => expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 8, 28).getTime() })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent("OpenAI · This instance · prev");
  expect(within(screen.getByRole("region", { name: "Limits and cost" })).getByText("$0.00")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Current account" })).not.toBeInTheDocument();
  expect(screen.getByText("No usage in this period")).toBeInTheDocument();
});

it("keeps the thread list at the height its grip was set to", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  window.localStorage.removeItem("pwragent.usageActivity.layout");
  const readUsageActivity = vi.fn(async () => ({ rows: [usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR })],
    readAt: now, rateLimits: [], truncated: false }));
  const first = render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  const grip = await screen.findByRole("separator", { name: "Resize thread list" });
  expect(document.querySelector(".usage-results")).not.toHaveAttribute("style");
  // A click without a drag keeps the list filling the window, now and next time.
  fireEvent.pointerDown(grip, { clientY: 400, pointerId: 1 });
  fireEvent.pointerUp(grip, { clientY: 400, pointerId: 1 });
  expect(window.localStorage.getItem("pwragent.usageActivity.layout")).toBeNull();
  // jsdom measures nothing, so the first step lands on the floor and the next adds to it.
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  expect(document.querySelector(".usage-results")).toHaveStyle({ height: "220px" });
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  expect(document.querySelector(".usage-results")).toHaveStyle({ height: "244px" });
  first.unmount();

  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  const again = await screen.findByRole("separator", { name: "Resize thread list" });
  expect(document.querySelector(".usage-results")).toHaveStyle({ height: "244px" });
  fireEvent.doubleClick(again);
  expect((document.querySelector(".usage-results") as HTMLElement).style.height).toBe("");
  expect(window.localStorage.getItem("pwragent.usageActivity.layout")).toBeNull();
});

it("rereads when the period or instances change, and on focus once the data is stale", async () => {
  let now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "owner", label: "Owner", status: "connected" }]) }} />);
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(2));

  choosePeriod("7 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(4));
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: now - 7 * 24 * HOUR, to: now }));

  choosePeriod("30 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(6));
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: now - 30 * 24 * HOUR, to: now }));

  // Turning an instance off rereads the rest; the last one cannot be turned off.
  fireEvent.click(screen.getByRole("button", { name: "Owner" }));
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(7));
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ federationTarget: { scope: "local" } }));
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");

  // Fresh data survives a focus; stale data is reread.
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(readUsageActivity).toHaveBeenCalledTimes(7);
  now += 2 * 60_000;
  act(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(8));
});

it("filters and ranks threads without rereading or launching analysis", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const row = usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 });
  const later = { ...usageFixture({ threadId: "other", usageLineId: "other", completedAt: at + HOUR, createdAt: at, startedAt: at, totalCostMicros: 900, inputTokens: 20, uncachedInputTokens: 10, cachedInputTokens: 10, outputTokens: 10 }), title: "Later thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [row, later], readAt: at, rateLimits: [], truncated: false }));
  const analyzeUsageActivity = vi.fn();
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T12:00");
  await waitFor(() => expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 8, 28, 9).getTime() })));
  await screen.findByRole("button", { name: "Inspect Later thread" });
  const reads = readUsageActivity.mock.calls.length;
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Later thread");
  chooseSelectOption(screen.getByLabelText("Sort threads"), "Most tokens");
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Fixture thread");
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "Later" } });
  expect(screen.queryByRole("button", { name: "Inspect Fixture thread" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "" } });
  const plot = screen.getByRole("group", { name: "Filter threads by completion time" });
  // Three hours draw as quarter-hour bars on the clock.
  expect(within(plot).getAllByRole("button")).toHaveLength(12);
  fireEvent.click(within(plot).getByRole("button", { name: /^10\sAM–10:15\sAM:/ }));
  expect(screen.queryByRole("button", { name: "Inspect Later thread" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Clear time filter/ }));
  expect(screen.getByRole("button", { name: "Inspect Later thread" })).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(reads);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
});

it("opens a charted thread in the main window, on its owner", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    rows: request.federationTarget?.scope === "remote"
      ? [{ ...usageFixture({ threadId: "peer-thread", createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR }), title: "Peer thread" }]
      : [] }));
  const openUsageThreadInMainWindow = vi.fn(async () => undefined);
  render(<UsageActivity desktopApi={{ readUsageActivity, openUsageThreadInMainWindow,
    readFederationActivity: peers([{ id: "owner", label: "Owner", status: "connected" }]) }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Peer thread" }));
  expect(openUsageThreadInMainWindow).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "peer-thread",
    federationTarget: { scope: "remote", instanceId: "owner" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect Peer thread" }));
  fireEvent.click(screen.getByRole("button", { name: "Open thread ↗" }));
  expect(openUsageThreadInMainWindow).toHaveBeenCalledTimes(2);
});

it("says why work is not counted", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const running = { ...usageFixture({ threadId: "running", usageLineId: "running", createdAt: now - HOUR, startedAt: now - HOUR, completedAt: undefined }), title: "Running thread" };
  const earlier = { ...usageFixture({ threadId: "earlier", usageLineId: "earlier", createdAt: now - 30 * HOUR, startedAt: now - 30 * HOUR, completedAt: now - 20 * HOUR }), title: "Earlier thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [running, earlier], readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  choosePeriod("24 h");
  fireEvent.click(await screen.findByRole("button", { name: "2 not counted" }));
  expect(within(screen.getByRole("button", { name: "Inspect Running thread" })).getByText("Still running, or its end was never recorded")).toBeInTheDocument();
  expect(within(screen.getByRole("button", { name: "Inspect Earlier thread" })).getByText("Started before this period")).toBeInTheDocument();
});

it("starts Since reset at an unexpected reset and says so", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  // The weekly schedule says the window began days ago; a reset at 9:30 restarted it.
  const resetAt = now + 4 * 24 * HOUR;
  const reading = (at: number, usedPercent: number): UsageLimitObservation => ({ observedAt: at, accountKey: "acct", planType: "plus",
    limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 }] });
  const before = { ...usageFixture({ threadId: "before", usageLineId: "before", createdAt: now - 5 * HOUR, startedAt: now - 5 * HOUR, completedAt: now - 4 * HOUR }), title: "Before the reset" };
  const after = { ...usageFixture({ threadId: "after", usageLineId: "after", createdAt: now - HOUR, startedAt: now - HOUR, completedAt: now - 30 * 60_000 }), title: "After the reset" };
  const readUsageActivity = vi.fn(async () => ({ rows: [before, after], readAt: now, rateLimits: [], truncated: false,
    limitObservation: reading(now - 10 * 60_000, 7),
    limitHistory: [reading(now - 4 * HOUR, 62), reading(now - 2.5 * HOUR, 1), reading(now - 10 * 60_000, 7)] }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "Since reset" })).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByText(/Unexpected reset seen/)).toBeInTheDocument();
  // The window turned out shorter than the provisional read, so it is read
  // once more over itself: owners bucket helper rollups by the window read.
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(2));
  expect(readUsageActivity).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: now - 8 * 24 * HOUR, to: now }));
  expect(readUsageActivity).toHaveBeenNthCalledWith(2, expect.objectContaining({ from: now - 2.5 * HOUR, to: now }));
  expect(screen.getByRole("img", { name: "Weekly limit 7% used" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect After the reset" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Before the reset" })).not.toBeInTheDocument();
  // A turn that finished before the reset is outside the window, not work left uncounted.
  expect(screen.queryByRole("button", { name: /not counted/ })).not.toBeInTheDocument();
});

it("reads a monthly credit limit from its start, once more, within the 31-day bound", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const credit: UsageLimitObservation = { observedAt: now - HOUR, accountKey: "work", planType: "business", limits: [
    { name: "Individual limit", windowKey: "individual", usedPercent: 37.2, used: 37_223, limit: 100_000, resetAt: new Date(2026, 8, 30).getTime() },
    { name: "Credits", windowKey: "credits", hasCredits: true },
  ] };
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false, limitObservation: credit }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(await screen.findByRole("img", { name: "Individual limit 37% used" })).toBeInTheDocument();
  expect(screen.getByText(/37.2K of 100K used/)).toBeInTheDocument();
  expect(screen.getByText("Available")).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(2);
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 7, 30).getTime(), to: now }));
});

/** Turns over a 9 AM–noon custom range, which charts as quarter-hour bars. */
async function renderSlices(rows: ReturnType<typeof usageFixture>[], desktopApi: Record<string, unknown> = {}) {
  const readUsageActivity = vi.fn(async () => ({ rows, readAt: new Date(2026, 8, 28, 12).getTime(), rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity, ...desktopApi }} />);
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T12:00");
  await waitFor(() => expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 8, 28, 9).getTime() })));
  await screen.findAllByRole("button", { name: /^Inspect / });
  const plot = screen.getByRole("group", { name: "Filter threads by completion time" });
  return { plot, bar: (label: RegExp) => within(plot).getByRole("button", { name: label }) };
}
const sliceTurn = (thread: string, minute: number, dollars: number, extra: Record<string, unknown> = {}) => {
  const start = new Date(2026, 8, 28, 9, 30).getTime();
  return { ...usageFixture({ threadId: thread, usageLineId: `${thread}-${minute}`, turnId: `${thread}-${minute}`, createdAt: start, startedAt: start,
    completedAt: new Date(2026, 8, 28, 10, minute).getTime(), totalCostMicros: dollars * 1_000_000, ...extra }), title: `${thread} thread` };
};
const cardOf = (bar: HTMLElement) => document.getElementById(bar.getAttribute("aria-describedby") ?? "")!;
const cardRows = (card: HTMLElement) => [...card.querySelectorAll(".usage-slice-card__row")].map((row) => row.textContent);

it("names what is in a slice on hover, in stack order, and follows the segment under the pointer", async () => {
  // Five threads get chart colors; f and g share Other.
  const { plot, bar } = await renderSlices([sliceTurn("a", 5, 4), sliceTurn("a", 6, 3), sliceTurn("b", 5, 6), sliceTurn("c", 5, 5),
    sliceTurn("d", 5, 4), sliceTurn("e", 5, 3), sliceTurn("f", 5, 2), sliceTurn("g", 5, 1), sliceTurn("h", 65, 1)]);
  const slice = bar(/^10\sAM–10:15\sAM:/);
  expect(slice).not.toHaveAttribute("aria-describedby");
  fireEvent.mouseEnter(slice);
  const card = cardOf(slice);
  expect(card).toHaveTextContent(/^10\sAM–10:15\sAM\$28\.00/);
  expect(card).toHaveTextContent("8 completed turns · 7 threads");
  // Top of the stack first: the highest series down to series 0, then Other, counted.
  expect(cardRows(card)).toEqual(["e thread1 turn · This instance$3.00", "d thread1 turn · This instance$4.00",
    "c thread1 turn · This instance$5.00", "b thread1 turn · This instance$6.00", "a thread2 turns · This instance$7.00",
    "2 other threads2 turns$3.00"]);
  expect(card).toHaveTextContent("Click to pin and filter");
  expect(plot).toHaveClass("is-dimmed");
  expect(slice).toHaveClass("is-shown");

  // The segment under the pointer is outlined, and its card row and legend entry light.
  const segment = slice.querySelector(".usage-series--1")!;
  fireEvent.mouseEnter(segment);
  expect(segment).toHaveClass("is-hot");
  expect(card.querySelector(".usage-slice-card__row.is-hot")).toHaveTextContent("b thread");
  expect(document.querySelector(".usage-timeline__legend")).toHaveAttribute("data-hot", "1");
  fireEvent.mouseLeave(slice);
  expect(document.getElementById(card.id)).toBeNull();
  expect(plot).not.toHaveClass("is-dimmed");
  // An empty slice draws no card.
  fireEvent.mouseEnter(bar(/^9\sAM–9:15\sAM:/));
  expect(document.querySelector(".usage-slice-card")).toBeNull();

  // The legend names its threads through the portal tooltip, never a native
  // title, which could linger over the bars and name the wrong one.
  const legend = document.querySelector(".usage-timeline__legend")!;
  expect(legend.querySelectorAll("[title]")).toHaveLength(0);
  expect(legend.querySelector(".usage-timeline__legend-item")).toHaveAttribute("data-tooltip", "a thread");
});

it("pins a slice on click, says so in the chart and the list, and walks slices by keyboard", async () => {
  const openUsageThreadInMainWindow = vi.fn(async () => undefined);
  const { plot, bar } = await renderSlices([sliceTurn("a", 5, 7), sliceTurn("b", 5, 6), sliceTurn("c", 5, 5), sliceTurn("d", 5, 4),
    sliceTurn("e", 5, 3), sliceTurn("f", 5, 2), sliceTurn("g", 5, 1), sliceTurn("h", 65, 1)], { openUsageThreadInMainWindow });
  const slice = bar(/^10\sAM–10:15\sAM:/);
  // The bars are one Tab stop, the latest slice with turns in it.
  expect(within(plot).getAllByRole("button").filter((button) => button.tabIndex === 0)).toEqual([bar(/^11\sAM–11:15\sAM:/)]);
  fireEvent.mouseEnter(slice);
  fireEvent.click(slice);
  fireEvent.mouseLeave(slice);
  const card = screen.getByRole("group", { name: /^10\sAM–10:15\sAM slice$/ });
  expect(slice).toHaveAttribute("aria-pressed", "true");
  expect(slice).toHaveClass("is-selected");
  expect(plot).not.toHaveClass("is-dimmed");
  expect(screen.getByRole("button", { name: /^Unpin 10\sAM–10:15\sAM$/ })).toBeInTheDocument();
  expect(document.querySelector(".usage-results__title")).toHaveTextContent("Threads 7 of 8");
  expect(screen.getByRole("button", { name: "Clear time filter" })).toHaveTextContent(/^Completed 10\sAM–10:15\sAM×$/);
  // Pinned, Other lists its threads, and each name opens its thread.
  expect(cardRows(card).slice(-2)).toEqual(["f thread ↗1 turn · This instance$2.00", "g thread ↗1 turn · This instance$1.00"]);
  fireEvent.click(within(card).getByRole("button", { name: "Open g thread" }));
  expect(openUsageThreadInMainWindow).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "g" });
  expect(within(document.querySelector<HTMLElement>(".usage-timeline__legend")!).getByRole("button", { name: "Open a thread" }))
    .toHaveAttribute("data-tooltip", "Open a thread");

  // The arrows pass over empty slices, and the pin and focus follow.
  act(() => slice.focus());
  fireEvent.keyDown(slice, { key: "ArrowRight" });
  const next = bar(/^11\sAM–11:15\sAM:/);
  expect(next).toHaveFocus();
  expect(next).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("group", { name: /^11\sAM–11:15\sAM slice$/ })).toHaveTextContent("h thread");
  expect(document.querySelector(".usage-results__title")).toHaveTextContent("Threads 1 of 8");
  // Escape from inside the card unpins and puts focus back on the bar.
  const action = within(screen.getByRole("group", { name: /slice$/ })).getByRole("button", { name: "Open h thread" });
  act(() => action.focus());
  fireEvent.keyDown(action, { key: "Escape" });
  expect(screen.queryByRole("group", { name: /slice$/ })).not.toBeInTheDocument();
  expect(next).toHaveFocus();
  expect(next).toHaveAttribute("aria-pressed", "false");
  expect(document.querySelector(".usage-results__title")).toHaveTextContent(/^Threads 8$/);

  // A single-segment slice still pins, and the chip unpins it.
  fireEvent.click(next);
  expect(screen.getByRole("group", { name: /^11\sAM–11:15\sAM slice$/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Unpin 11\sAM–11:15\sAM$/ }));
  expect(screen.queryByRole("button", { name: "Clear time filter" })).not.toBeInTheDocument();
  expect(next).toHaveFocus();
});

it("reads a slice by model, and a pinned model name narrows the threads to it", async () => {
  const { bar } = await renderSlices([sliceTurn("a", 5, 3, { model: "gpt-6", modelLabel: "GPT-6" }),
    sliceTurn("b", 6, 2, { model: "gpt-6", modelLabel: "GPT-6" }), sliceTurn("c", 7, 1, { model: "grok-5", modelLabel: "Grok 5" })]);
  fireEvent.click(within(screen.getByRole("group", { name: "Spend by" })).getByRole("button", { name: "Model" }));
  const slice = bar(/^10\sAM–10:15\sAM:/);
  fireEvent.mouseEnter(slice);
  expect(cardOf(slice)).toHaveTextContent("3 completed turns · 2 models");
  expect(cardRows(cardOf(slice))).toEqual(["Grok 51 turn · This instance$1.00", "GPT-62 threads · 2 turns$5.00"]);
  fireEvent.click(slice);
  const card = screen.getByRole("group", { name: /slice$/ });
  fireEvent.click(within(card).getByRole("button", { name: "Grok 5" }));
  expect(screen.getByText("Model: Grok 5")).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Grok 5" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "Inspect a thread" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect c thread" })).toBeInTheDocument();
});
