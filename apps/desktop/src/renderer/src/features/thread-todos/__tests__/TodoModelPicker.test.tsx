import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared/contracts/thread-todos";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import {
  CURRENT_CODEX_MODEL_LABELS,
  PROVIDER_MODEL,
  codexCatalogModels,
  composerDropdownOptionLabels,
} from "../../../test/model-catalog";
import { chooseEffort, chooseModelSettingsOption } from "../../../test/model-settings";

const thread: ThreadTodoModelSettings = { backend: "claude", model: "opus", reasoningEffort: "high" };
const codex: ThreadTodoModelSettings = { backend: "codex", model: "sol", reasoningEffort: "high" };
const backends = [
  { kind: "claude", label: "Claude", available: true, capabilities: { createThread: true },
    launchpadOptions: { models: [{ id: "opus", label: "Opus 5.5", current: true, reasoningEfforts: ["medium", "high", "xhigh"] }] } },
  { kind: "codex", label: "Codex", available: true, capabilities: { createThread: true },
    launchpadOptions: { models: [{ id: "sol", label: "GPT-6.1-Sol", current: true, reasoningEfforts: ["medium", "high"] }] } },
] as BackendSummary[];
const base: ThreadTodo = { id: "card", backend: "claude", threadId: "thread-a", kind: "handoff", status: "open",
  title: "Cache the signing-key lookup", createdAt: 0, updatedAt: 0,
  action: { type: "start_thread", prompt: "Cache the key", workMode: "worktree" }, dispatchDefaults: { thread } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(todo = base, recents = [codex], catalog = backends) {
  const onRun = vi.fn();
  const api = { listModelSettingsRecents: vi.fn(async () => ({ recents })) };
  const card = (value: ThreadTodo) => <ThreadTodoCard todo={value} running={false} now={0}
    onRun={onRun} onResolve={vi.fn()} onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />;
  const tree = (value: ThreadTodo, visible = true) => (
    <TodoDispatchProvider api={api} backends={catalog} todos={[value]}>{visible ? card(value) : null}</TodoDispatchProvider>
  );
  const result = render(tree(todo));
  return { ...result, onRun, api, tree };
}

const LABEL = "Model for the new thread";

async function openPicker() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Model for the new thread:/ })); });
  return screen.getByRole("dialog", { name: LABEL });
}

/** The one-click rows above the editor: This thread, Suggested, Recent. */
function readyRows(panel: HTMLElement): HTMLElement[] {
  return within(within(panel).getByRole("listbox", { name: "Ready settings" })).getAllByRole("option");
}

function rowName(row: HTMLElement): string {
  const detail = row.getAttribute("aria-description");
  return `${row.getAttribute("aria-label")}${detail ? ` (${detail})` : ""}`;
}

describe("to-do dispatch model picker", () => {
  it("shows an explicit cross-provider proposal over dispatch history and sends those settings", async () => {
    const todo: ThreadTodo = { ...base, backend: "codex", action: {
      type: "start_thread", prompt: "Review it", backend: "claude", model: "opus", reasoningEffort: "high",
      executionMode: "auto", workMode: "local",
    }, dispatchDefaults: { thread: codex, lastDispatch: codex } };
    const { onRun } = setup(todo, []);
    expect(screen.getByRole("button", { name: "Model for the new thread: Claude, Opus 5.5, high effort" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show start settings" })); });
    expect(screen.getByRole("button", { name: "Model for the new thread: Claude, Opus 5.5, high effort" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenCalledWith(todo, expect.objectContaining({
      modelSettings: { backend: "claude", model: "opus", reasoningEffort: "high" },
    }));
  });

  it("offers a Codex model provider by its own name, as the composer's launchpad does", async () => {
    const settings: ThreadTodoModelSettings = { backend: "codex", model: "gpt-6.1-sol" };
    const todo = { ...base, dispatchDefaults: { thread: settings } };
    const { onRun } = setup(todo, [], [{ ...backends[1]!, launchpadOptions: { models: codexCatalogModels() } }]);
    const panel = await openPicker();
    expect(composerDropdownOptionLabels(within(panel).getByRole("listbox", { name: "Model" })))
      .toEqual(CURRENT_CODEX_MODEL_LABELS);
    const providers = within(panel).getByRole("listbox", { name: "Provider" });
    expect(composerDropdownOptionLabels(providers)).toEqual(["Codex", PROVIDER_MODEL.providerLabel]);
    await act(async () => {
      fireEvent.click(within(providers).getByRole("option", {
        name: (name) => name.startsWith(PROVIDER_MODEL.providerLabel!),
      }));
    });
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).getAttribute("aria-label"))
      .toBe(`Model for the new thread: ${PROVIDER_MODEL.providerLabel}, ${PROVIDER_MODEL.label}`);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("shares the composer's current models and keeps a selected legacy model under Other", async () => {
    const labels = ["GPT-6-Astra", "GPT-6.1-Sol", "GPT-6-Sol", "GPT-6.1-Terra", "GPT-6-Luna",
      "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna"];
    const settings: ThreadTodoModelSettings = { backend: "codex", model: "gpt-5.6-terra" };
    const todo = { ...base, dispatchDefaults: { thread: settings } };
    const catalog = [{ ...backends[1]!, launchpadOptions: {
      models: labels.map((label) => ({ id: label.toLowerCase(), label })),
    } }];
    const { onRun } = setup(todo, [], catalog);
    const panel = await openPicker();
    expect(composerDropdownOptionLabels(within(panel).getByRole("listbox", { name: "Model" }))).toEqual([
      "GPT-6-Astra", "GPT-6.1-Sol", "GPT-6.1-Terra", "GPT-6-Luna",
    ]);
    // The chosen legacy model opens Other in place.
    const other = within(panel).getByRole("listbox", { name: "Model: Other" });
    const legacy = within(other).getByRole("option", { name: "GPT-5.6-Terra" });
    expect(legacy.getAttribute("aria-selected")).toBe("true");
    expect(composerDropdownOptionLabels(other)).toEqual([
      "GPT-6-Sol", "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna",
    ]);
    chooseModelSettingsOption("Model", "GPT-6-Sol", LABEL);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenCalledWith(todo, { modelSettings: { backend: "codex", model: "gpt-6-sol" } });
  });

  it("always shows the Model fact first and opens This thread, Recent, then the editor with display labels", async () => {
    const { container, api } = setup();
    // No peer can host it, so the row has no Machine chip; Model leads.
    expect(within(screen.getByRole("group", { name: "Start settings" })).getAllByRole("button")[0]!.getAttribute("aria-label"))
      .toMatch(/^Model for the new thread:/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show start settings" })); });
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Model", "Thread", "Where", "Env"]);
    expect(screen.getByRole("button", { name: "Model for the new thread: Claude, Opus 5.5, high effort" }).getAttribute("aria-expanded")).toBe("false");
    const panel = await openPicker();
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).hasAttribute("data-tooltip")).toBe(false);
    expect(readyRows(panel).map(rowName)).toEqual([
      "Claude, Opus 5.5, high effort (This thread)", "Codex, GPT-6.1-Sol, high effort",
    ]);
    expect(within(panel).getByRole("group", { name: "Recent" })).toBeTruthy();
    expect(api.listModelSettingsRecents).toHaveBeenCalledWith({ scope: "todo-dispatch", federationTarget: undefined });
    expect(screen.queryByText("Picked for this card")).toBeNull();
    expect(document.activeElement).toBe(readyRows(panel)[0]);
  });

  it("places a bottom-edge panel above its chip and follows scroll geometry", async () => {
    let top = window.innerHeight - 30;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(200, top, 160, 22));
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    setup();
    const panel = await openPicker();
    expect(Number.parseFloat(panel.style.top)).toBe(top - 308);
    expect(Number.parseFloat(panel.style.maxHeight)).toBeGreaterThan(300);
    top = -50;
    await act(async () => { fireEvent.scroll(window); });
    expect(panel.style.top).toBe("8px");
    top = 10;
    await act(async () => { fireEvent.resize(window); });
    expect(panel.style.top).toBe("40px");
  });

  it("picks a recent for just this card, survives paging, and dispatches it", async () => {
    const { rerender, tree, onRun } = setup();
    const panel = await openPicker();
    fireEvent.click(within(panel).getByRole("option", { name: "Codex, GPT-6.1-Sol, high effort" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Picked for this card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).closest(".model-settings")?.className)
      .toContain("model-settings--changed");
    rerender(tree(base, false));
    rerender(tree(base));
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenCalledWith(base, { modelSettings: codex });
    fireEvent.click(screen.getByRole("button", { name: "↺ This thread's settings" }));
    expect(screen.queryByText("Picked for this card")).toBeNull();
  });

  it("uses per-thread memory ahead of a suggestion and offers Use suggestion", async () => {
    setup({ ...base, action: { type: "start_thread", prompt: "Go", reasoningEffort: "xhigh" },
      dispatchDefaults: { thread, lastDispatch: codex } });
    expect(screen.getByText(/Last used here. Agent suggested Claude · Opus 5.5 · xhigh/)).toBeTruthy();
    const panel = await openPicker();
    expect(rowName(readyRows(panel)[1]!)).toBe("Claude, Opus 5.5, xhigh effort (Suggested)");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "↺ Use suggestion" }));
    expect(screen.getByRole("button", { name: /Model for the new thread: Claude, Opus 5.5, xhigh/ })).toBeTruthy();
  });

  it("shows memory provenance without a suggestion and no note when settings match", () => {
    const todo = { ...base, dispatchDefaults: { thread, lastDispatch: codex } };
    const { rerender, tree } = setup(todo);
    expect(screen.getByText("Last used in this thread")).toBeTruthy();
    expect(screen.getByRole("button", { name: "↺ Claude · Opus 5.5 · high" })).toBeTruthy();
    rerender(tree({ ...base, dispatchDefaults: { thread, lastDispatch: thread } }));
    expect(screen.queryByText("Last used in this thread")).toBeNull();
  });

  it("walks the ready rows with arrows, Home and End; Escape and Tab out return to the chip", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: /^Model for the new thread:/ });
    const panel = await openPicker();
    const rows = readyRows(panel);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // The panel is portalled: Shift+Tab off its first stop and Tab off its
    // last both land on the chip and close it.
    await openPicker();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    const reopened = await openPicker();
    const slider = within(reopened).getByRole("slider", { name: "Effort" });
    slider.focus();
    fireEvent.keyDown(slider, { key: "Tab" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps editor changes open: provider, model and effort each take one click", async () => {
    const { onRun } = setup();
    const panel = await openPicker();
    fireEvent.click(within(within(panel).getByRole("listbox", { name: "Provider" })).getByRole("option", { name: "Codex" }));
    expect(screen.getByRole("dialog", { name: LABEL })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).getAttribute("aria-label"))
      .toBe("Model for the new thread: Codex, GPT-6.1-Sol, high effort");
    chooseEffort("medium", LABEL);
    expect(screen.getByRole("dialog", { name: LABEL })).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: LABEL })).getByRole("slider", { name: "Effort" })
      .getAttribute("aria-valuetext")).toBe("medium");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenCalledWith(base, {
      modelSettings: { backend: "codex", model: "sol", reasoningEffort: "medium" },
    });
  });

  it("filters missing models/providers, caps Recent at five, and closes on an outside pointer", async () => {
    setup(base, [{ backend: "claude", model: "removed" }, { backend: "acp:missing" },
      { ...codex, reasoningEffort: "removed-effort" },
      codex, { ...codex, reasoningEffort: "medium" }, { ...codex, reasoningEffort: undefined },
      thread, { ...thread, reasoningEffort: "medium" }, { ...thread, reasoningEffort: "xhigh" },
      { ...thread, reasoningEffort: undefined }]);
    const panel = await openPicker();
    expect(readyRows(panel)).toHaveLength(6);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the provider default when a start-capable backend offers no model list", async () => {
    const backend = { ...backends[0]!, launchpadOptions: {} };
    const todo = { ...base, dispatchDefaults: { thread: { backend: "claude" as const } } };
    render(<TodoDispatchProvider backends={[backend]} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} onRun={vi.fn()} onResolve={vi.fn()}
        onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>);
    const panel = await openPicker();
    const fallback = within(within(panel).getByRole("listbox", { name: "Model" })).getByRole("option", { name: "Default model" });
    expect(fallback.getAttribute("aria-selected")).toBe("true");
    expect(fallback.getAttribute("aria-disabled")).toBe("true");
  });

  it("uses one owner catalog for a remote card's chip and provenance", async () => {
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    const todo = { ...base, federationTarget, dispatchDefaults: {
      thread: { ...thread, model: "owner-opus" }, lastDispatch: codex,
    } };
    const ownerBackends = backends.map((backend) => backend.kind === "claude" ? {
      ...backend, launchpadOptions: { models: [{ id: "owner-opus", label: "Opus owner", reasoningEfforts: ["high"] }] },
    } : backend);
    const api = {
      listBackends: vi.fn(async () => ({ backends: ownerBackends, fetchedAt: 0 })),
      listModelSettingsRecents: vi.fn(async () => ({ recents: [codex] })),
    };
    render(<TodoDispatchProvider api={api} backends={backends} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} onRun={vi.fn()} onResolve={vi.fn()}
        onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>);
    expect(await screen.findByRole("button", { name: "↺ Claude · Opus owner · high" })).toBeTruthy();
    expect(api.listBackends).toHaveBeenCalledExactlyOnceWith({ federationTarget });
    const panel = await openPicker();
    expect(within(panel).getByRole("option", { name: "Claude, Opus owner, high effort" })).toBeTruthy();
    expect(api.listModelSettingsRecents).toHaveBeenCalledWith({ scope: "todo-dispatch", federationTarget });
  });

  it("freezes a failed attempt for Retry even if another dispatch changes memory", () => {
    const { rerender, tree, onRun } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    const failed = { ...base, error: "Unavailable", dispatchDefaults: { thread, lastDispatch: codex } };
    rerender(tree(failed));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRun).toHaveBeenLastCalledWith(failed, { modelSettings: thread });
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).getAttribute("data-tooltip")).toBe("Settings for the start on this thread's machine.");
  });
});
