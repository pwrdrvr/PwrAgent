import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";

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

afterEach(cleanup);

function setup(todo = base, recents = [codex]) {
  const onRun = vi.fn();
  const api = { listModelSettingsRecents: vi.fn(async () => ({ recents })) };
  const card = (value: ThreadTodo) => <ThreadTodoCard todo={value} running={false} now={0}
    onRun={onRun} onResolve={vi.fn()} onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />;
  const tree = (value: ThreadTodo, visible = true) => (
    <TodoDispatchProvider api={api} backends={backends} todos={[value]}>{visible ? card(value) : null}</TodoDispatchProvider>
  );
  const result = render(tree(todo));
  return { ...result, onRun, api, tree };
}

async function openPicker() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Model for the new thread:/ })); });
  return screen.getByRole("menu", { name: "Model for the new thread" });
}

describe("to-do dispatch model picker", () => {
  it("always shows the Model fact first and opens This thread, Recent, then Custom with display labels", async () => {
    const { container, api } = setup();
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Model", "Where"]);
    expect(screen.getByRole("button", { name: "Model for the new thread: Claude, Opus 5.5, high" }).getAttribute("aria-expanded")).toBe("false");
    const menu = await openPicker();
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).hasAttribute("data-tooltip")).toBe(false);
    expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual([
      "Claude · Opus 5.5 · highThis thread", "Codex · GPT-6.1-Sol · high",
    ]);
    expect(api.listModelSettingsRecents).toHaveBeenCalledWith({ scope: "todo-dispatch", federationTarget: undefined });
    expect(screen.queryByText("Picked for this card")).toBeNull();
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitemradio")[0]);
  });

  it("picks a recent for just this card, survives paging, and dispatches it", async () => {
    const { rerender, tree, onRun } = setup();
    await openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex · GPT-6.1-Sol · high" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Picked for this card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).className).toContain("is-changed");
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
    const menu = await openPicker();
    expect(within(menu).getAllByRole("menuitemradio")[1]?.textContent).toBe("Claude · Opus 5.5 · xhighSuggested");
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

  it("uses useMenuNavigation arrows, Home, End, Escape and Tab including Custom triggers", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: /^Model for the new thread:/ });
    const menu = await openPicker();
    const rows = within(menu).getAllByRole("menuitemradio");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("To-do reasoning: high");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await openPicker();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Custom changes open and lets the nested dropdown claim its arrow keys and Escape", async () => {
    setup();
    await openPicker();
    fireEvent.click(screen.getByRole("menuitem", { name: "To-do provider: Claude" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Codex");
    fireEvent.click(document.activeElement!);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "To-do model: GPT-6.1-Sol" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "To-do reasoning: high" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("filters missing models/providers, caps Recent at five, and closes on an outside pointer", async () => {
    setup(base, [{ backend: "claude", model: "removed" }, { backend: "acp:missing" },
      ...Array.from({ length: 7 }, (_, index) => ({ ...codex, reasoningEffort: `effort-${index}` }))]);
    const menu = await openPicker();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(6);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("names the provider default when a start-capable backend offers no model list", async () => {
    const backend = { ...backends[0]!, launchpadOptions: {} };
    const todo = { ...base, dispatchDefaults: { thread: { backend: "claude" as const } } };
    render(<TodoDispatchProvider backends={[backend]} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} onRun={vi.fn()} onResolve={vi.fn()}
        onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>);
    await openPicker();
    expect(screen.getByRole("menuitem", { name: "To-do model: Default model" }).hasAttribute("disabled")).toBe(true);
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
      listBackends: vi.fn(async () => ({ backends: ownerBackends })),
      listModelSettingsRecents: vi.fn(async () => ({ recents: [codex] })),
    };
    render(<TodoDispatchProvider api={api} backends={backends} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} onRun={vi.fn()} onResolve={vi.fn()}
        onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>);
    expect(await screen.findByRole("button", { name: "↺ Claude · Opus owner · high" })).toBeTruthy();
    expect(api.listBackends).toHaveBeenCalledExactlyOnceWith({ federationTarget });
    const menu = await openPicker();
    expect(within(menu).getByRole("menuitemradio", { name: /Claude · Opus owner · high/ })).toBeTruthy();
    expect(api.listModelSettingsRecents).toHaveBeenCalledWith({ scope: "todo-dispatch", federationTarget });
  });

  it("freezes a failed attempt for Retry even if another dispatch changes memory", () => {
    const { rerender, tree, onRun } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    const failed = { ...base, error: "Unavailable", dispatchDefaults: { thread, lastDispatch: codex } };
    rerender(tree(failed));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRun).toHaveBeenLastCalledWith(failed, { modelSettings: thread });
    expect(screen.getByRole("button", { name: /^Model for the new thread:/ }).getAttribute("data-tooltip")).toContain("peer’s defaults");
  });
});
