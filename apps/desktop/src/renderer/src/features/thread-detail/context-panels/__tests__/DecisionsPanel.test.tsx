import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DecisionsRailBatch,
  DecisionsRailBatchPage,
  DecisionsRailBatchRequest,
  DecisionsRailSnapshot,
} from "@pwragent/shared/decisions-rail";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopDecisionModelSettings } from "@pwragent/shared/decision-models";
import { DecisionsPanel, type DecisionSetupSettings } from "../DecisionsPanel";

afterEach(cleanup);

const NOW = new Date(2026, 10, 19, 14, 4, 41).getTime();
const THREAD = { backend: "codex", threadId: "thread-1" };
const THUMBNAIL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";

const running: DecisionsRailBatch = {
  batchId: "batch_run-1",
  decisionId: "dec_1",
  name: "triage_relevance",
  version: 2,
  adHoc: false,
  provider: "openai",
  model: "gpt-6-luna",
  state: "running",
  stopping: false,
  background: true,
  count: 1000,
  finished: 640,
  succeeded: 631,
  failed: 9,
  skipped: 0,
  concurrency: 8,
  createdAt: NOW - 161_000,
  startedAt: NOW - 161_000,
  wallMs: 161_000,
  itemsPerSecond: 640 / 161,
  latency: { samples: 631, meanMs: 380, maxMs: 2_100 },
  hasResultsFile: true,
};

const stopped: DecisionsRailBatch = {
  ...running,
  batchId: "batch_old-1",
  version: 1,
  state: "stopped",
  background: false,
  count: 120,
  finished: 120,
  succeeded: 12,
  failed: 1,
  skipped: 107,
  createdAt: NOW - 3 * 3_600_000,
  startedAt: NOW - 3 * 3_600_000,
  stoppedBy: { code: "credential_rejected", message: "The OpenAI key was rejected." },
};

const snapshot: DecisionsRailSnapshot = {
  now: NOW,
  decisions: [
    {
      decisionId: "dec_1",
      name: "triage_relevance",
      version: 2,
      scope: "thread",
      provider: "openai",
      providerDisabled: false,
      questions: [
        { type: "predicate", name: "relevant" },
        { type: "choice", name: "severity", choices: ["low", "medium", "high", "critical"] },
      ],
      inputSchema: { type: "object", properties: { title: { type: "string" }, labels: { type: "array" } } },
      timing: { samples: 200, minMs: 120, maxMs: 2_100, meanMs: 410, p50Ms: 390 },
    },
    {
      decisionId: "dec_2",
      name: "operator_present",
      version: 4,
      scope: "profile",
      provider: "local",
      providerDisabled: true,
      questions: [{ type: "predicate", name: "present" }],
      inputSchema: { type: "string" },
    },
  ],
  batches: [running, stopped],
};

function page(request: DecisionsRailBatchRequest): DecisionsRailBatchPage {
  const items: DecisionsRailBatchPage["items"] = [
    {
      index: 0,
      ok: true,
      inputPreview: "{\"title\":\"Sidebar flickers when a thread finishes\"}",
      inputImages: [{ mimeType: "image/jpeg", width: 1, height: 1, thumbnail: THUMBNAIL }],
      durationMs: 402,
      answers: [
        { type: "predicate", name: "relevant", value: "yes", probability: 0.93 },
        { type: "choice", name: "severity", value: "medium", probability: 0.71 },
      ],
    },
    { index: 3, ok: false, code: "rate_limited", message: "Retried 3 times, gave up.", inputPreview: "{\"title\":\"Export\"}", durationMs: 9_200 },
  ];
  return {
    batch: running,
    definition: {
      prefix: "You triage bug reports for a desktop app.",
      questions: [
        { type: "predicate", name: "relevant", instructions: "Is this report about the sidebar?" },
        {
          type: "choice",
          name: "severity",
          instructions: "How bad is it?",
          options: [{ label: "low" }, { label: "medium", description: "Annoying but has a workaround" }],
        },
      ],
    },
    items: request.status === "failed" ? items.filter((item) => !item.ok) : items,
  };
}

const UNSET = { configured: false, source: "unset", writable: true } as const;
const SAVED = { configured: true, source: "config", writable: true } as const;

/** Only the Settings fields the Decisions tab reads. */
function settingsSnapshot(params: {
  openaiKey?: boolean;
  jevKey?: boolean;
  decisionModels?: DesktopDecisionModelSettings;
} = {}): DesktopSettingsSnapshot {
  return {
    models: {
      decisionModels: params.decisionModels,
      openaiDecisions: { apiKey: params.openaiKey ? SAVED : UNSET },
      decisionSecrets: { localApiKey: UNSET, jevApiKey: params.jevKey ? SAVED : UNSET },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function setupSettings(snapshotValue: DesktopSettingsSnapshot): DecisionSetupSettings & {
  writeConfig: ReturnType<typeof vi.fn>;
  replaceSecret: ReturnType<typeof vi.fn>;
} {
  return {
    snapshot: snapshotValue,
    saving: false,
    writeConfig: vi.fn(async () => true),
    replaceSecret: vi.fn(async () => true),
    clearSecret: vi.fn(async () => true),
  };
}

function renderPanel(overrides: {
  snapshot?: DecisionsRailSnapshot;
  settings?: DecisionSetupSettings;
  onOpenSettings?: (focus?: string) => void;
  readDecisionsRailBatch?: (request: DecisionsRailBatchRequest) => Promise<DecisionsRailBatchPage>;
} = {}) {
  const readDecisionsRailBatch = vi.fn(overrides.readDecisionsRailBatch ?? (async (request: DecisionsRailBatchRequest) => page(request)));
  const actOnDecisionsRailBatch = vi.fn(async () => ({ outcome: "stopped" as const }));
  const openDecisionsRailResults = vi.fn(async () => ({ opened: true }));
  const onRefresh = vi.fn();
  const onDetailsModalOpenChange = vi.fn();
  const panel = (next: DecisionsRailSnapshot | undefined) => (
    <DecisionsPanel
      desktopApi={{ readDecisionsRailBatch, actOnDecisionsRailBatch, openDecisionsRailResults }}
      thread={THREAD}
      snapshot={next}
      error={false}
      onRefresh={onRefresh}
      settings={overrides.settings}
      onOpenSettings={overrides.onOpenSettings}
      onDetailsModalOpenChange={onDetailsModalOpenChange}
    />
  );
  const view = render(panel(overrides.snapshot ?? snapshot));
  const rerender = (next: DecisionsRailSnapshot | undefined) => view.rerender(panel(next));
  return { readDecisionsRailBatch, actOnDecisionsRailBatch, openDecisionsRailResults, onRefresh, onDetailsModalOpenChange, rerender, unmount: view.unmount };
}

it("lists registered decisions and marks one whose provider is off", () => {
  renderPanel();
  expect(screen.getByRole("heading", { name: "Registered 2" })).toBeInTheDocument();
  expect(screen.getByText("2 questions · mean 410 ms over 200 requests")).toBeInTheDocument();
  expect(screen.getByText("Local model · off")).toBeInTheDocument();

  const toggle = screen.getByRole("button", { name: /operator_present/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/Local decision model is turned off in Settings → AI Providers/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /triage_relevance/ }));
  expect(screen.getByText("choice · low · medium · high · critical")).toBeInTheDocument();
  expect(screen.getByText("{ title, labels[] }")).toBeInTheDocument();
});

it("shows each batch's status, counts and timing, newest first", () => {
  renderPanel();
  expect(screen.getByRole("heading", { name: "Batches 2" })).toBeInTheDocument();
  const cards = screen.getAllByRole("listitem").filter((item) => item.classList.contains("decisions-batch"));
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText("Running")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("background")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("640 of 1000 items done: 631 succeeded, 9 failed, 0 skipped")).toBeInTheDocument();
  expect(within(cards[0]!).getByText(/2m 41s · 4\.0\/s · mean 380 ms · max 2\.1 s/)).toBeInTheDocument();
  expect(within(cards[1]!).getByText("Stopped")).toBeInTheDocument();
  expect(within(cards[1]!).getByText(/credential_rejected after 13 items/)).toBeInTheDocument();
  // Only a running batch can be stopped.
  expect(within(cards[0]!).getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(within(cards[1]!).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
});

it("stops a running batch from its card", async () => {
  const api = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.actOnDecisionsRailBatch).toHaveBeenCalledWith({ ...THREAD, batchId: "batch_run-1", action: "stop" }));
  await waitFor(() => expect(api.onRefresh).toHaveBeenCalled());
});

it("opens a batch for review: its prompt, its items as fields, answers with probabilities", async () => {
  const api = renderPanel();
  fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]!);
  expect(api.onDetailsModalOpenChange).toHaveBeenCalledWith(true);
  const dialog = await screen.findByRole("dialog", { name: "Decision batch: triage_relevance v2" });
  const list = await within(dialog).findByRole("listbox", { name: "Items" });
  expect(api.readDecisionsRailBatch).toHaveBeenCalledWith({ ...THREAD, batchId: "batch_run-1", status: "all", from: 0, limit: 100 });
  expect(within(dialog).getByText("OpenAI · gpt-6-luna")).toBeInTheDocument();

  // The prompt every item shared.
  expect(within(dialog).getByText("Prompt · the same for every item")).toBeInTheDocument();
  expect(within(dialog).getByText("You triage bug reports for a desktop app.")).toBeInTheDocument();
  expect(within(dialog).getByText("Is this report about the sidebar?")).toBeInTheDocument();
  expect(within(dialog).getByText("Annoying but has a workaround")).toBeInTheDocument();

  // The list summarizes each item by its text, never as JSON.
  const options = within(list).getAllByRole("option");
  expect(options).toHaveLength(2);
  expect(within(options[0]!).getByText("Sidebar flickers when a thread finishes")).toBeInTheDocument();
  expect(within(options[0]!).getByAltText("Image 1 · JPEG · 1 × 1")).toHaveAttribute("src", THUMBNAIL);
  expect(within(options[0]!).getByText("yes · 0.93")).toBeInTheDocument();
  expect(within(options[1]!).getByText("rate_limited")).toBeInTheDocument();
  expect(within(dialog).queryByText(/\{"title"/)).not.toBeInTheDocument();

  // The first item is selected: its answers and its input as fields.
  const detail = within(dialog).getByRole("region", { name: "Item 0" });
  expect(within(detail).getByText("402 ms", { exact: false })).toBeInTheDocument();
  expect(within(detail).getByText("relevant")).toBeInTheDocument();
  expect(within(detail).getByText("0.93")).toBeInTheDocument();
  expect(within(detail).getByText("medium")).toBeInTheDocument();
  expect(within(detail).getByText("title")).toBeInTheDocument();
  expect(within(detail).getByText("Sidebar flickers when a thread finishes")).toBeInTheDocument();

  // Arrow keys move through the list.
  fireEvent.keyDown(list, { key: "ArrowDown" });
  const failed = within(dialog).getByRole("region", { name: "Item 3" });
  expect(within(failed).getByText("Retried 3 times, gave up.")).toBeInTheDocument();
  expect(options[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(list, { key: "k" });
  expect(within(dialog).getByRole("region", { name: "Item 0" })).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("tab", { name: "Failed 9" }));
  await waitFor(() => expect(api.readDecisionsRailBatch).toHaveBeenLastCalledWith({ ...THREAD, batchId: "batch_run-1", status: "failed", from: 0, limit: 100 }));
  await waitFor(() => expect(within(dialog).getByRole("region", { name: "Item 3" })).toBeInTheDocument());

  fireEvent.click(within(dialog).getByRole("button", { name: "Open results file" }));
  await waitFor(() => expect(api.openDecisionsRailResults).toHaveBeenCalledWith({ ...THREAD, batchId: "batch_run-1" }));

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(api.actOnDecisionsRailBatch).toHaveBeenCalledWith({ ...THREAD, batchId: "batch_run-1", action: "cancel" }));

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.onDetailsModalOpenChange).toHaveBeenLastCalledWith(false);
});

// Rule: an ad hoc definition is never stored, so its placeholder name and
// version are not shown; the batch says what it asked instead.
it("calls an ad hoc batch Ad hoc, with no version, and names its questions", () => {
  const adHoc: DecisionsRailBatch = {
    ...running,
    batchId: "batch_adhoc-1",
    decisionId: "adhoc:0123",
    name: "ad_hoc",
    version: 1,
    adHoc: true,
    state: "completed",
    questionNames: ["preferred_caption"],
  };
  renderPanel({ snapshot: { now: NOW, decisions: [], batches: [adHoc] } });
  const card = screen.getAllByRole("listitem").find((item) => item.classList.contains("decisions-batch"))!;
  expect(within(card).getByText("Ad hoc")).toBeInTheDocument();
  expect(within(card).getByText("not stored")).toBeInTheDocument();
  expect(within(card).queryByText("v1")).not.toBeInTheDocument();
  expect(within(card).queryByText("ad_hoc")).not.toBeInTheDocument();
  expect(within(card).getByText("Asks preferred_caption")).toBeInTheDocument();
});

it("says so when the thread has no decisions and no batches", () => {
  renderPanel({ snapshot: { now: NOW, decisions: [], batches: [] } });
  expect(screen.getByText(/None saved/)).toBeInTheDocument();
  expect(screen.getByText("This thread has not run a decision batch.")).toBeInTheDocument();
});

// Rule: a thread that has not used decisions, on a profile with no
// provider ready, gets the pitch and a way to set one up.
it("pitches decisions and opens setup when no provider is ready", async () => {
  const settings = setupSettings(settingsSnapshot());
  const onOpenSettings = vi.fn();
  const api = renderPanel({ snapshot: { now: NOW, decisions: [], batches: [] }, settings, onOpenSettings });
  expect(screen.getByRole("heading", { name: /Ask one typed question/ })).toBeInTheDocument();
  expect(screen.getByText("OpenAI Decisions").nextElementSibling).toHaveTextContent("Needs key");
  expect(screen.getByText("Local decision model").nextElementSibling).toHaveTextContent("Not chosen");

  fireEvent.click(screen.getByRole("button", { name: "Set up decisions" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose where decisions run" });
  expect(api.onDetailsModalOpenChange).toHaveBeenLastCalledWith(true);
  // The first provider that needs something opens with its key field.
  expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "Use local model" }));
  await waitFor(() => expect(settings.writeConfig).toHaveBeenCalledWith({ models: { decisionModels: { model: "local" } } }));

  fireEvent.click(within(dialog).getByRole("button", { name: "All decision settings" }));
  expect(onOpenSettings).toHaveBeenCalledWith(undefined);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.onDetailsModalOpenChange).toHaveBeenLastCalledWith(false);
});

it.each([
  ["jev-preview", "clef-flash", /^Experimental image input/, /^Image input/],
  ["jev-1.12.0", "text-only", /^Images unavailable/, /^Images unavailable/],
])("discloses image input for the configured %s and %s models", async (jev, local, jevLabel, localLabel) => {
  const settings = setupSettings(settingsSnapshot({
    decisionModels: { jev: { model: jev }, local: { model: local } },
  }));
  renderPanel({ snapshot: { now: NOW, decisions: [], batches: [] }, settings });
  fireEvent.click(screen.getByRole("button", { name: "Set up decisions" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Choose where decisions run" }));
  const card = (name: string) => within(dialog.getByRole("heading", { name }).closest("li")!);
  expect(card("OpenAI Decisions").getByText(/^Image input.*PNG or JPEG/)).toBeInTheDocument();
  expect(card("TypeSafe Jev").getByText(jevLabel)).toBeInTheDocument();
  expect(card("Local decision model").getByText(localLabel)).toBeInTheDocument();
});

it("suggests something to ask once a provider is ready", () => {
  renderPanel({
    snapshot: { now: NOW, decisions: [], batches: [] },
    settings: setupSettings(settingsSnapshot({ jevKey: true })),
  });
  expect(screen.queryByRole("heading", { name: /Ask one typed question/ })).not.toBeInTheDocument();
  expect(screen.getByText("TypeSafe Jev is ready. Try asking:")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Providers" })).toBeInTheDocument();
});

// Rule: whenever the batch dialog is gone, the rail hears it closed, or the
// hover rail stays pinned open with nothing on it.
it("releases the rail when the open batch leaves the snapshot or the panel unmounts", async () => {
  const api = renderPanel();
  fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]!);
  await screen.findByRole("dialog");
  expect(api.onDetailsModalOpenChange).toHaveBeenLastCalledWith(true);

  // A thread switch: the new thread's snapshot has not arrived yet.
  api.rerender(undefined);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.onDetailsModalOpenChange).toHaveBeenLastCalledWith(false);

  api.rerender(snapshot);
  fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]!);
  await screen.findByRole("dialog");
  api.onDetailsModalOpenChange.mockClear();
  api.unmount();
  expect(api.onDetailsModalOpenChange).toHaveBeenCalledWith(false);
});

// Rule: one failed read does not freeze a running batch's dialog; the next
// poll reads again.
it("keeps polling a running batch after a failed read", async () => {
  let calls = 0;
  const api = renderPanel({
    readDecisionsRailBatch: async (request) => {
      calls += 1;
      if (calls === 1) throw new Error("ipc hiccup");
      return page(request);
    },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]!);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("listbox", { name: "Items" }, { timeout: 4_000 });
  expect(api.readDecisionsRailBatch).toHaveBeenCalledTimes(2);
}, 10_000);
