import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { chooseSpeed, openModelSettings, speedChoices } from "../../../test/model-settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, ListBackendsRequest } from "@pwragent/shared/contracts/backend";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  ListThreadTodoDispatchEnvironmentsRequest,
  ListThreadTodoDispatchEnvironmentsResponse,
  SetThreadTodoAccessRequest,
  ThreadTodo,
} from "@pwragent/shared/contracts/thread-todos";
import type {
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import type { ThreadTodoInstance } from "../thread-todos-view";

const claude = {
  kind: "claude", label: "Claude", available: true, capabilities: { createThread: true },
  launchpadOptions: { models: [{ id: "opus", label: "Opus 5.5", current: true, reasoningEfforts: ["medium", "high"] }] },
} as BackendSummary;
const codex = (overrides: Partial<BackendSummary> = {}) => ({
  kind: "codex", label: "OpenAI", available: true, capabilities: { createThread: true }, codexFastAllowed: true,
  launchpadOptions: { models: [{
    id: "sol", label: "GPT-6.1-Sol", current: true, reasoningEfforts: ["medium", "high"], supportsFast: true,
    serviceTiers: ["ultrafast"],
  }] },
  ...overrides,
}) as BackendSummary;

const MAC = { instanceId: "mac", label: "studio" };
const WIN: ThreadTodoInstance = { instanceId: "win", label: "win-lab / dev", dispatchTarget: true };
const ATLAS = { key: "directory:/src/atlas", label: "atlas", path: "/src/atlas" };
const thread = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };

const card: ThreadTodo = {
  id: "card", backend: "claude", threadId: "thread-a", kind: "handoff", status: "open",
  title: "Reproduce the shutdown-probe timeout on Windows", createdAt: 0, updatedAt: 0,
  sourceProject: ATLAS, cwd: "/wt/atlas",
  action: { type: "start_thread", prompt: "Run the focused suite" },
  dispatchDefaults: { thread },
};

const ENVIRONMENTS: Record<string, ListThreadTodoDispatchEnvironmentsResponse> = {
  owner: {
    projectFound: true, projectLabel: "atlas", defaultEnvironmentId: "dev", defaultSource: "thread",
    environments: [{ id: "dev", name: "Dev" }, { id: "ci", name: "CI" }],
    repositoryKey: "github.com/fixture-org/atlas",
  },
  win: {
    projectFound: true, projectLabel: "atlas", defaultEnvironmentId: "win-ci", defaultSource: "project",
    environments: [{ id: "win-ci", name: "Windows CI" }],
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function row(id: string, title: string, overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id, title, titleSource: "generated", source: "codex", linkedDirectories: [], inbox: { unread: false },
    updatedAt: 1, ...overrides,
  } as NavigationThreadSummary;
}

function onPeer(thread: NavigationThreadSummary, instanceId: string, instanceLabel: string): NavigationThreadSummary {
  return { ...thread, federation: {
    ref: { backend: thread.source, threadId: thread.id, target: { scope: "remote", instanceId } }, instanceLabel,
  } } as NavigationThreadSummary;
}

const PR_OWNER = row("pr-owner", "Refresh PR #42");

function setup(options: {
  todo?: ThreadTodo;
  local?: BackendSummary[];
  win?: BackendSummary[];
  instances?: ThreadTodoInstance[];
  localCodexFastAllowed?: boolean;
  backendsTarget?: FederationTarget;
  /** Mounted copies of the card, as the stack and the To-dos panel both show it. */
  copies?: number;
  onDoHere?: (todo: ThreadTodo) => void;
  /** What this machine's owner search answers; filtered by title. */
  ownerRows?: NavigationThreadSummary[];
  /** The Updated lens page an empty field lists. */
  recentRows?: NavigationThreadSummary[];
  /** What connected peers answer. */
  peerRows?: NavigationThreadSummary[];
} = {}) {
  const todo = options.todo ?? card;
  const onRun = vi.fn();
  const api = {
    getNavigationQueryPage: vi.fn(async (request: NavigationQueryRequest) => {
      const query = request.query;
      const rows = query.kind === "search"
        ? (options.ownerRows ?? [PR_OWNER]).filter((thread) => thread.title.toLowerCase().includes(query.text.toLowerCase()))
        : options.recentRows ?? [];
      return {
        protocol: 2, queryKey: query.kind, generation: "generation", ownerEpoch: "owner", countsRevision: "counts",
        counts: { total: rows.length, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: true,
        entries: rows.map((thread) => ({ row: thread })),
      } as unknown as NavigationQueryPage;
    }),
    jumpSearchRemoteThreads: vi.fn(async (request: { query: string }) => ({
      results: (options.peerRows ?? []).filter((thread) => thread.title.toLowerCase().includes(request.query.toLowerCase())),
    })),
    listBackends: vi.fn(async (request?: ListBackendsRequest) => ({
      fetchedAt: 0,
      backends: request?.federationTarget?.scope === "remote" && request.federationTarget.instanceId === "win"
        ? options.win ?? [codex()]
        : options.local ?? [claude, codex()],
    })),
    listModelSettingsRecents: vi.fn(async () => ({ recents: [] })),
    listThreadTodoDispatchEnvironments: vi.fn(async (request: ListThreadTodoDispatchEnvironmentsRequest) =>
      ENVIRONMENTS[request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "owner"]!),
    setThreadTodoAccess: vi.fn(async (_request: SetThreadTodoAccessRequest) => ({ todo })),
  };
  const tree = (value: ThreadTodo, visible = true) => (
    <TodoDispatchProvider api={api}
      backends={options.backendsTarget?.scope === "remote" ? options.win ?? [codex()] : options.local ?? [claude, codex()]}
      backendsTarget={options.backendsTarget} todos={[value]}
      {...(options.localCodexFastAllowed === undefined ? {} : { localCodexFastAllowed: options.localCodexFastAllowed })}>
      {visible ? Array.from({ length: options.copies ?? 1 }, (_, index) => (
        <ThreadTodoCard key={index} todo={value} running={false} now={0} onRun={onRun} onResolve={vi.fn()}
          onStartReview={vi.fn()} onSetItemChecked={vi.fn()}
          {...(options.onDoHere ? { onDoHere: options.onDoHere } : {})}
          instances={options.instances ?? [WIN]} localMachine={MAC} />
      )) : null}
    </TodoDispatchProvider>
  );
  const result = render(tree(todo));
  return { ...result, onRun, api, tree };
}

const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}: `) });

async function choose(chipName: string, option: string) {
  await act(async () => { fireEvent.click(chip(chipName)); });
  const menu = screen.getByRole("menu", { name: chipName });
  await act(async () => { fireEvent.click(within(menu).getByRole("menuitemradio", { name: new RegExp(`^${option}`) })); });
}

const MODEL = "Model for the new thread";

/** Open the model panel, letting its recents load, and return it. */
async function openModelPanel(): Promise<HTMLElement> {
  if (chip(MODEL).getAttribute("aria-expanded") !== "true") {
    await act(async () => { fireEvent.click(chip(MODEL)); });
  }
  return openModelSettings(MODEL);
}

/** Close the model panel the way a keyboard user does. */
async function closeModelPanel() {
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const field = () => screen.getByRole("combobox", { name: "Find destination thread" });

/** Type into the destination field and let the palette's 200 ms debounce answer. */
async function search(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
  await settle();
}

async function openPicker() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Handoff options" })); });
  await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: "Send to thread…" })); });
  await settle();
}

const optionNames = () => screen.queryAllByRole("option").map((option) => option.querySelector(".jump-palette__row-title")?.textContent);

describe("to-do dispatch target", () => {
  it("previews an existing thread request without sending until the operator clicks Send", async () => {
    const { onRun, api } = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Handoff options" })); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: "Send to thread…" })); });
    expect((screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Machine:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    await search("42");
    await act(async () => { fireEvent.click(within(screen.getByRole("option")).getByRole("button", { name: /Refresh PR #42/ })); });
    expect(onRun).not.toHaveBeenCalled();
    expect(api.getNavigationQueryPage).toHaveBeenCalledWith(
      expect.objectContaining({ inventory: "owner", query: { kind: "search", text: "42" } }), expect.any(String));
    fireEvent.click(screen.getByRole("button", { name: "Show the whole proposed prompt" }));
    expect(screen.getByRole("region", { name: "Proposed prompt" }).textContent).toContain("Run the focused suite");
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(onRun).toHaveBeenCalledWith(card, { messageTarget: {
      backend: "codex", threadId: "pr-owner", title: "Refresh PR #42", instanceLabel: "studio",
    } });
  });

  it("leads with Do it here when the request names the card's own thread", async () => {
    const target = { backend: "claude" as const, threadId: "thread-a", title: "An older title" };
    const onDoHere = vi.fn();
    const { onRun } = setup({ onDoHere, todo: { ...card, action: { type: "send_message", prompt: "Follow up", target } } });
    expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Handoff options" })); });
    expect(screen.queryByRole("menuitem", { name: "Do it here" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Handoff options" })); });
    fireEvent.click(screen.getByRole("button", { name: "Do it here" }));
    expect(onDoHere.mock.calls[0]?.[0]).toMatchObject({ id: "card" });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("disables a send to the card's own thread when it cannot be done here", () => {
    const target = { backend: "claude" as const, threadId: "thread-a" };
    setup({ todo: { ...card, action: { type: "send_message", prompt: "Follow up", target } } });
    expect((screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches a Do it here handoff to a new thread without running it on selection", async () => {
    const target = { backend: "claude" as const, threadId: "thread-a" };
    const todo: ThreadTodo = { ...card, action: { type: "send_message", prompt: "Follow up", target } };
    const onDoHere = vi.fn();
    const { onRun } = setup({ todo, onDoHere });
    const chooseHandoff = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
      const menu = screen.getByRole("menu", { name: "Handoff options" });
      const item = within(menu).queryByRole("menuitemradio", { name });
      expect(item, `${name} should be available`).not.toBeNull();
      await act(async () => { fireEvent.click(item!); });
    };
    expect(screen.getByRole("button", { name: "Do it here" })).toBeTruthy();
    await chooseHandoff("Start a new thread");
    await chooseHandoff("Send to thread…");
    expect(screen.getByRole("button", { name: "Do it here" })).toBeTruthy();
    await chooseHandoff("Start a new thread");
    expect(chip("Model for the new thread")).toBeTruthy();
    expect(onDoHere).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenCalledWith(todo, expect.objectContaining({ startNewThread: true, modelSettings: thread }));
    expect(onRun.mock.calls[0]?.[1]).not.toHaveProperty("messageTarget");
  });

  it("shows the agent's proposed destination before sending", async () => {
    const target = { backend: "codex" as const, threadId: "owner", title: "Existing PR owner" };
    const { onRun } = setup({ todo: { ...card, action: { type: "send_message", prompt: "Refresh the PR", target } } });
    expect(screen.getByText("Existing PR owner")).toBeTruthy();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "send_message", prompt: "Refresh the PR", target } }), { messageTarget: target });
  });

  it("lists recent threads before any text, then searches as you type", async () => {
    setup({
      recentRows: [row("recent", "Rebalance desktop E2E shard durations", {
        gitBranch: "ci/refit-desktop-e2e-shards",
        linkedDirectories: [{ id: "pwragent", label: "PwrAgnt", path: "/src/pwragent", kind: "local" }],
      })],
      ownerRows: [PR_OWNER, row("bench", "Benchmark the limiter under load")],
    });
    await openPicker();
    expect(optionNames()).toEqual(["Rebalance desktop E2E shard durations"]);
    expect(within(screen.getByRole("option")).getByText("ci/refit-desktop-e2e-shards")).toBeTruthy();
    expect(within(screen.getByRole("option")).getByText("PwrAgnt")).toBeTruthy();
    await search("bench");
    expect(optionNames()).toEqual(["Benchmark the limiter under load"]);
    await search("refresh");
    expect(optionNames()).toEqual(["Refresh PR #42"]);
    await search("quarterly forecast");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No threads match")).toBeTruthy();
  });

  it("moves with the arrows, wraps, and picks with Enter", async () => {
    const { onRun } = setup({ ownerRows: [row("a", "Rate limits A"), row("b", "Rate limits B"), row("c", "Rate limits C")] });
    await openPicker();
    await search("rate");
    const active = () => document.getElementById(field().getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toContain("Rate limits A");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(active()).toContain("Rate limits C");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(active()).toContain("Rate limits B");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(onRun).toHaveBeenCalledWith(card, { messageTarget: {
      backend: "codex", threadId: "b", title: "Rate limits B", instanceLabel: "studio",
    } });
  });

  it("cancels a change with Escape and keeps the destination", async () => {
    const target = { backend: "codex" as const, threadId: "owner", title: "Existing PR owner" };
    const { onRun } = setup({ todo: { ...card, action: { type: "send_message", prompt: "Refresh the PR", target } } });
    const change = screen.getByRole("button", { name: "Change" });
    fireEvent.click(change);
    expect(document.activeElement).toBe(field());
    await search("42");
    expect(optionNames()).toEqual(["Refresh PR #42"]);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(change);
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(onRun).toHaveBeenCalledWith(expect.anything(), { messageTarget: target });
  });

  it("lists peers' threads under Other instances and addresses them on their machine", async () => {
    const { onRun } = setup({
      // The card's own thread (claude thread-a) is never offered.
      ownerRows: [PR_OWNER, row("thread-a", "Refresh PR #42 from here", { source: "claude" })],
      peerRows: [onPeer(row("lab-thread", "Refresh PR #42 on the lab"), "lab", "lab-mini / default")],
    });
    await openPicker();
    await search("refresh pr");
    expect(optionNames()).toEqual(["Refresh PR #42", "Refresh PR #42 on the lab"]);
    expect(screen.getByText("Other instances")).toBeTruthy();
    const peer = screen.getAllByRole("option")[1]!;
    expect(peer.textContent).toContain("lab-mini / default");
    fireEvent.click(within(peer).getByRole("button", { name: /Refresh PR #42 on the lab/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(onRun).toHaveBeenCalledWith(card, { messageTarget: {
      backend: "codex", threadId: "lab-thread", title: "Refresh PR #42 on the lab",
      instanceId: "lab", instanceLabel: "lab-mini / default",
    } });
  });

  it.each([false, true])("addresses a remote card's search result relative to its owner (result on owner: %s)", async (onOwner) => {
    const remote = { ...card, id: "remote-todo:win:card", federationTarget: { scope: "remote" as const, instanceId: "win" } };
    const { onRun } = setup({
      todo: remote, instances: [{ ...WIN, messageTarget: true }],
      ownerRows: [onOwner ? onPeer(PR_OWNER, "win", "win-lab / dev") : PR_OWNER],
    });
    await settle();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Handoff options" })); });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Send to thread…" }));
    await search("42");
    fireEvent.click(within(screen.getByRole("option")).getByRole("button", { name: /Refresh PR #42/ }));
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const selected = onRun.mock.calls[0]?.[1]?.messageTarget;
    expect(selected).toMatchObject({ backend: "codex", threadId: "pr-owner" });
    expect(selected?.instanceId).toBe(onOwner ? undefined : "mac");
  });
  it("expands the chips to the labelled grid, moves focus with the toggle, and keeps it across a remount", async () => {
    const { container, rerender, tree } = setup();
    await settle();
    const expand = screen.getByRole("button", { name: "Show start settings" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { fireEvent.click(expand); });
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Machine", "Model", "Thread", "Where", "Env"]);
    expect(screen.queryByRole("group", { name: "Start settings" })).toBeNull();
    const collapse = screen.getByRole("button", { name: "Hide start settings labels" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(collapse);
    // The grid names each fact, so its chips carry no icon or name tooltip.
    expect(chip("Machine for the new thread").hasAttribute("data-tooltip")).toBe(false);
    expect(chip("Machine for the new thread").querySelector(".todo-model-picker__lead")).toBeNull();

    // Paging away and back, or moving to the To-dos tab, remounts the card.
    rerender(tree(card, false));
    rerender(tree(card));
    expect(screen.getByRole("button", { name: "Hide start settings labels" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide start settings labels" })); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show start settings" }));
    expect(container.querySelector("dt")).toBeNull();
  });

  it("keeps the stack's and the To-dos panel's copies of a card in step", async () => {
    setup({ copies: 2 });
    await settle();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Show start settings" })[0]!); });
    expect(screen.getAllByRole("button", { name: "Hide start settings labels" })).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Hide start settings labels" })[1]!); });
    expect(screen.getAllByRole("button", { name: "Show start settings" })).toHaveLength(2);
  });

  it("shows every choice on the card, defaulting to the thread's machine, checkout and environment", async () => {
    const { container, api } = setup();
    await settle();
    // At rest the choices are one row of chips with no labels.
    const row = screen.getByRole("group", { name: "Start settings" });
    expect(within(row).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Machine for the new thread: studio",
      "Model for the new thread: Claude, Opus 5.5, high effort",
      "Where the new thread is filed: Top-level",
      "Where the new thread works: This thread's directory",
      "Environment for the new thread: Dev",
      "Show start settings",
    ]);
    expect(chip("Machine for the new thread").getAttribute("data-tooltip")).toBe("Machine: studio");
    expect(chip("Where the new thread works").getAttribute("data-tooltip")).toBe("Where: This thread's directory");
    expect(chip("Environment for the new thread").getAttribute("data-tooltip")).toBe("Environment: Dev");
    expect(container.querySelector("dt")).toBeNull();
    expect(chip("Machine for the new thread").getAttribute("aria-label")).toBe("Machine for the new thread: studio");
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high effort");
    expect(chip("Where the new thread works").textContent).toBe("This thread's directory");
    expect(chip("Environment for the new thread").textContent).toBe("Dev");
    expect(api.listThreadTodoDispatchEnvironments).toHaveBeenCalledWith({ id: "card" });
  });

  it("files a top-level thread's follow-up as another top-level thread by default", async () => {
    const { onRun } = setup();
    await settle();
    // A sibling of a thread with no parent is a top-level thread: one row.
    expect(chip("Where the new thread is filed").textContent).toBe("Top-level");
    expect(chip("Where the new thread is filed").getAttribute("data-tooltip")).toBe("Thread: New thread in atlas");
    await act(async () => { fireEvent.click(chip("Where the new thread is filed")); });
    const menu = within(screen.getByRole("menu", { name: "Where the new thread is filed" }));
    expect(menu.getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual([
      "Sub-thread of this thread",
      "New thread in atlasDefault",
    ]);
    await act(async () => { fireEvent.click(menu.getByRole("menuitemradio", { name: /^Sub-thread of this thread/ })); });
    expect(chip("Where the new thread is filed").classList.contains("is-changed")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, expect.objectContaining({ placement: "sub_thread" }));
    // Back to the default sends nothing, so the owner's own default holds.
    await choose("Where the new thread is filed", "New thread in atlas");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun.mock.calls.at(-1)?.[1]).not.toHaveProperty("placement");
  });

  it("files a child thread's follow-up beside it, under the same parent, by default", async () => {
    const child: ThreadTodo = { ...card, dispatchDefaults: { thread, threadParent: { backend: "claude", threadId: "cpu-analysis" } } };
    const { onRun } = setup({ todo: child });
    await settle();
    expect(chip("Where the new thread is filed").textContent).toBe("Sibling");
    expect(chip("Where the new thread is filed").getAttribute("data-tooltip")).toBe("Thread: Sibling of this thread, under its parent");
    await act(async () => { fireEvent.click(chip("Where the new thread is filed")); });
    const menu = within(screen.getByRole("menu", { name: "Where the new thread is filed" }));
    expect(menu.getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual([
      "Sibling of this threadDefault",
      "Sub-thread of this thread",
      "New thread in atlas",
    ]);
    await act(async () => { fireEvent.click(menu.getByRole("menuitemradio", { name: /^New thread in atlas/ })); });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(child, expect.objectContaining({ placement: "top_level" }));
    await choose("Where the new thread is filed", "Sibling of this thread");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun.mock.calls.at(-1)?.[1]).not.toHaveProperty("placement");
  });

  it("offers an owner without siblings only its own two placements, defaulting to a sub-thread", async () => {
    const remote: ThreadTodo = {
      ...card, federationTarget: { scope: "remote", instanceId: "win" },
      dispatchDefaults: { thread, threadParent: { backend: "claude", threadId: "cpu-analysis" } },
    };
    setup({ todo: remote, instances: [{ ...WIN, placement: true }], backendsTarget: { scope: "remote", instanceId: "win" } });
    await settle();
    expect(chip("Where the new thread is filed").textContent).toBe("Sub-thread");
    await act(async () => { fireEvent.click(chip("Where the new thread is filed")); });
    expect(within(screen.getByRole("menu", { name: "Where the new thread is filed" }))
      .getAllByRole("menuitemradio").map((entry) => entry.textContent))
      .toEqual(["Sub-thread of this threadDefault", "New thread in atlas"]);
  });

  it("starts with the agent's top-level proposal, and sends a sub-thread pick against it", async () => {
    const proposed: ThreadTodo = { ...card, action: { type: "start_thread", prompt: "Run the focused suite", placement: "top_level" } };
    const { onRun } = setup({ todo: proposed });
    await settle();
    expect(chip("Where the new thread is filed").textContent).toBe("Top-level");
    expect(chip("Where the new thread is filed").classList.contains("is-changed")).toBe(false);
    await act(async () => { fireEvent.click(chip("Where the new thread is filed")); });
    expect(within(screen.getByRole("menu", { name: "Where the new thread is filed" }))
      .getByRole("menuitemradio", { name: /^New thread in atlas/ }).textContent).toBe("New thread in atlasProposed");
    await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: /^Sub-thread of this thread/ })); });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(proposed, expect.objectContaining({ placement: "sub_thread" }));
  });

  it("locks the placement to top-level for another project or machine, and sends no pick there", async () => {
    const { unmount } = setup({ todo: { ...card, targetProject: { key: "directory:/src/snap", label: "PwrSnap", path: "/src/snap" } } });
    await settle();
    const crossProject = chip("Where the new thread is filed") as HTMLButtonElement;
    expect(crossProject.disabled).toBe(true);
    expect(crossProject.textContent).toBe("Top-level");
    expect(crossProject.getAttribute("data-tooltip")).toBe("Work for another project always starts as a top-level thread there.");
    unmount();

    const peerRun = setup().onRun;
    await settle();
    await choose("Where the new thread is filed", "Sub-thread of this thread");
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    const peer = chip("Where the new thread is filed") as HTMLButtonElement;
    expect(peer.disabled).toBe(true);
    expect(peer.getAttribute("data-tooltip")).toBe("A thread on another machine starts at the top of its project there.");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(peerRun.mock.calls.at(-1)?.[1]).not.toHaveProperty("placement");
  });

  it("shows an older owner's card as a sub-thread it cannot change", async () => {
    const remote: ThreadTodo = { ...card, federationTarget: { scope: "remote", instanceId: "win" } };
    const { onRun } = setup({ todo: remote, instances: [{ ...WIN, placement: false }] });
    await settle();
    const locked = chip("Where the new thread is filed") as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute("data-tooltip")).toBe("Update PwrAgent on win-lab / dev to choose where the new thread is filed.");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun.mock.calls.at(-1)?.[1]).not.toHaveProperty("placement");
  });

  it("lets an owner that honors placement take a pick from a viewer", async () => {
    const remote: ThreadTodo = { ...card, federationTarget: { scope: "remote", instanceId: "win" } };
    const { onRun } = setup({ todo: remote, instances: [{ ...WIN, placement: true }], backendsTarget: { scope: "remote", instanceId: "win" } });
    await settle();
    await choose("Where the new thread is filed", "New thread in");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(remote, expect.objectContaining({ placement: "top_level" }));
  });

  it("fits the model to a peer that lacks the provider, and restores the Mac's settings on the way back", async () => {
    const { onRun, api } = setup();
    await settle();
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    expect(api.listBackends).toHaveBeenCalledWith({ federationTarget: { scope: "remote", instanceId: "win" } });
    // The owner names the repository, so the peer can find a copy it files
    // under another name.
    expect(api.listThreadTodoDispatchEnvironments.mock.calls.slice(-2).map(([request]) => request)).toEqual([
      { id: "card", repositoryOnly: true },
      { project: { ...ATLAS, repositoryKey: "github.com/fixture-org/atlas" }, federationTarget: { scope: "remote", instanceId: "win" } },
    ]);
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: OpenAI, GPT-6.1-Sol, high effort");
    expect(screen.getByText("Claude is not set up on win-lab / dev. Using another provider.")).toBeTruthy();
    expect(chip("Where the new thread works").textContent).toBe("atlas checkout");
    expect(chip("Environment for the new thread").textContent).toBe("Windows CI");
    // A peer start carries fast mode only, so Ultrafast is not offered there.
    await openModelPanel();
    expect(speedChoices(MODEL)).toEqual(["Standard", "Fast"]);
    await act(async () => { chooseSpeed("Fast", MODEL); });
    await closeModelPanel();
    expect(chip(MODEL).getAttribute("aria-label")).toBe("Model for the new thread: OpenAI, GPT-6.1-Sol, high effort, Fast");
    await choose("Where the new thread works", "New worktree");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, {
      startOnInstanceId: "win",
      modelSettings: { backend: "codex", model: "sol", reasoningEffort: "high" },
      speed: "fast",
      workMode: "worktree",
      environment: "win-ci",
    });

    await choose("Machine for the new thread", "studio");
    await settle();
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high effort");
    expect(chip(MODEL).hasAttribute("data-speed")).toBe(false);
    expect(chip("Environment for the new thread").textContent).toBe("Dev");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, { modelSettings: thread, workMode: "worktree", environment: "dev" });

    // The peer's choices are still there when the card goes back to it.
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    expect(chip(MODEL).getAttribute("data-speed")).toBe("fast");
  });

  it("keeps a model picked for the peer on the peer only", async () => {
    const { onRun } = setup({ win: [codex(), { ...claude, launchpadOptions: { models: [
      { id: "sonnet", label: "Sonnet 5.5", current: true, reasoningEfforts: ["medium"] },
    ] } } as BackendSummary] });
    await settle();
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    // Claude is there, without Opus: the provider stays and its default model is used.
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Sonnet 5.5, medium effort");
    expect(screen.getByText("Claude · Opus 5.5 is not offered on win-lab / dev. Using its default model.")).toBeTruthy();
    const panel = await openModelPanel();
    // This thread's own settings cannot run there, so the row is left out.
    expect(within(panel).queryAllByRole("option")
      .filter((option) => option.getAttribute("aria-description") === "This thread")).toEqual([]);
    await act(async () => {
      fireEvent.click(within(within(panel).getByRole("listbox", { name: "Provider" })).getByRole("option", { name: "OpenAI" }));
    });
    await closeModelPanel();
    await choose("Machine for the new thread", "studio");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, { modelSettings: thread, environment: "dev" });
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: OpenAI, GPT-6.1-Sol, high effort");
  });

  it("locks Speed at Standard when the chosen machine turned Fast off", async () => {
    setup({ win: [codex({ codexFastAllowed: false })] });
    await settle();
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    // The pill draws no bolt at Standard; the panel says why Fast is gone.
    expect(chip(MODEL).getAttribute("data-speed")).toBe("standard");
    expect(chip(MODEL).querySelector(".model-settings__pill-bolt")).toBeNull();
    const panel = await openModelPanel();
    expect(within(panel).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Standard"]);
    expect(within(panel).getByText("Fast mode is turned off in Settings → Models on win-lab / dev.")).toBeTruthy();
  });

  it("follows this machine's Allow Fast mode setting for a Codex thread, and inherits its speed when allowed", async () => {
    const todo = { ...card, backend: "codex" as const, dispatchDefaults: {
      thread: { backend: "codex" as const, model: "sol", reasoningEffort: "high" }, threadSpeed: { fastMode: true },
    } };
    const { onRun, unmount } = setup({ todo, localCodexFastAllowed: false });
    await settle();
    expect(chip(MODEL).getAttribute("data-speed")).toBe("standard");
    const panel = await openModelPanel();
    expect(within(panel).getByText("Fast mode is turned off in Settings → Models.")).toBeTruthy();
    unmount();

    const allowed = setup({ todo });
    await settle();
    // A paid tier lights the pill's bolt and is named, as the composer draws it.
    expect(chip(MODEL).getAttribute("aria-label")).toMatch(/, Fast$/);
    expect(chip(MODEL).querySelector(".model-settings__pill-bolt")).toBeTruthy();
    expect(chip(MODEL).closest(".model-settings")?.className).not.toContain("model-settings--changed");
    // Ultrafast is offered on the card's own machine.
    await openModelPanel();
    expect(speedChoices(MODEL)).toEqual(["Standard", "Fast", "Ultrafast"]);
    await closeModelPanel();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    // Unchanged, the owner inherits the thread's exact speed.
    expect(allowed.onRun).toHaveBeenLastCalledWith(todo, expect.not.objectContaining({ speed: expect.anything() }));
    await openModelPanel();
    await act(async () => { chooseSpeed("Standard", MODEL); });
    await closeModelPanel();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(allowed.onRun).toHaveBeenLastCalledWith(todo, expect.objectContaining({ speed: "standard" }));
    expect(onRun).not.toHaveBeenCalled();
  });

  it("lets the operator clear or change the environment", async () => {
    const { onRun } = setup();
    await settle();
    await act(async () => { fireEvent.click(chip("Environment for the new thread")); });
    const menu = screen.getByRole("menu", { name: "Environment for the new thread" });
    expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent))
      .toEqual(["DevThis thread", "CI", "No environment"]);
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitemradio", { name: "No environment" })); });
    expect(chip("Environment for the new thread").className).toContain("is-changed");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, expect.objectContaining({ environment: "none" }));
    await choose("Environment for the new thread", "CI");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, expect.objectContaining({ environment: "ci" }));
  });

  it("offers a peer's card to this machine, and shows an older owner's card as before", async () => {
    const remote = { ...card, id: "remote-todo:win:card", federationTarget: { scope: "remote" as const, instanceId: "win" },
      dispatchDefaults: { thread: { backend: "codex" as const, model: "sol", reasoningEffort: "high" } } };
    const { onRun, unmount } = setup({ todo: remote });
    await settle();
    expect(chip("Machine for the new thread").textContent).toBe("win-lab / dev");
    await choose("Machine for the new thread", "studio");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(remote, expect.objectContaining({
      startOnInstanceId: "mac", modelSettings: { backend: "codex", model: "sol", reasoningEffort: "high" }, workMode: "local",
    }));
    unmount();

    const legacy = setup({ todo: remote, instances: [{ ...WIN, dispatchTarget: false }] });
    await settle();
    expect(screen.queryByRole("button", { name: /^Machine for the new thread/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Environment for the new thread/ })).toBeNull();
    expect(chip(MODEL).hasAttribute("data-speed")).toBe(false);
    expect(screen.getByText("Where").nextElementSibling?.textContent).toBe("This thread's directory");
    expect(legacy.api.listThreadTodoDispatchEnvironments).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(legacy.onRun).toHaveBeenLastCalledWith(remote, { modelSettings: { backend: "codex", model: "sol", reasoningEffort: "high" } });
  });

  it("keeps Windows as the viewer's default and explicitly reads the gateway's models and environments when picked", async () => {
    const remote = { ...card, id: "remote-todo:win:card", backend: "codex" as const,
      federationTarget: { scope: "remote" as const, instanceId: "win" },
      dispatchDefaults: { thread: { backend: "codex" as const, model: "sol", reasoningEffort: "high" } } };
    const { onRun, api } = setup({ todo: remote, local: [claude], backendsTarget: remote.federationTarget });
    await settle();
    expect(chip("Machine for the new thread").textContent).toBe("win-lab / dev");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(remote, expect.not.objectContaining({ startOnInstanceId: expect.anything() }));

    await choose("Machine for the new thread", "studio");
    await settle();
    expect(api.listBackends).toHaveBeenCalledWith({ federationTarget: { scope: "local" } });
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high effort");
    expect(api.listThreadTodoDispatchEnvironments).toHaveBeenCalledWith({ id: remote.id, repositoryOnly: true });
    expect(api.listThreadTodoDispatchEnvironments).toHaveBeenLastCalledWith({
      project: { ...ATLAS, repositoryKey: "github.com/fixture-org/atlas" }, federationTarget: { scope: "local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(remote, expect.objectContaining({
      startOnInstanceId: "mac", modelSettings: thread, environment: "dev",
    }));

    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(remote, expect.not.objectContaining({ startOnInstanceId: expect.anything() }));
  });

  it("leaves an offline peer out and keeps a connected unsupported one disabled", async () => {
    setup({ instances: [
      WIN,
      { instanceId: "ci", label: "ci-runner", availability: "offline" },
      { instanceId: "old", label: "old-box", availability: "unsupported" },
    ] });
    await settle();
    await act(async () => { fireEvent.click(chip("Machine for the new thread")); });
    const menu = within(screen.getByRole("menu", { name: "Machine for the new thread" }));
    expect(menu.queryByRole("menuitemradio", { name: /ci-runner/ })).toBeNull();
    const unsupported = menu.getByRole("menuitemradio", { name: /old-box/ });
    expect(unsupported.getAttribute("aria-disabled")).toBe("true");
    expect(unsupported.textContent).toBe("old-boxUnsupported");
  });
});

describe("to-do card access", () => {
  const modes = (...available: Array<"default" | "auto" | "full-access">) =>
    (["default", "auto", "full-access"] as const).map((mode) => ({ mode, label: mode, available: available.includes(mode) }));
  const antigravity = {
    kind: "acp:antigravity", label: "Antigravity", available: true, capabilities: { createThread: true },
    executionModes: [],
    acp: { runtime: { schemaVersion: 1, status: "ready", modes: { currentModeId: "default", availableModes: [
      { id: "default", label: "Default" }, { id: "accept-edits", label: "Accept edits" },
      { id: "auto", label: "Auto" }, { id: "plan", label: "Plan" },
    ] } } },
    launchpadOptions: { models: [{ id: "gemini", label: "Gemini 3", current: true }] },
  } as unknown as BackendSummary;
  const startButton = () => screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement;
  const accessChip = () => screen.getByTestId("todo-dispatch-access");

  it("shows the inherited access and offers only the provider's available modes", async () => {
    setup({
      todo: { ...card, dispatchDefaults: { thread, threadExecutionMode: "auto" } },
      local: [{ ...claude, executionModes: modes("default", "auto") }, codex()],
    });
    await settle();
    expect(accessChip().getAttribute("aria-label")).toBe("Access for the new thread: Auto");
    await act(async () => { fireEvent.click(accessChip()); });
    const menu = screen.getByRole("menu", { name: "Access for the new thread" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Default Access", "AutoThis thread"]);
  });

  it("shows the agent's own mode for a native-mode agent, and stores the operator's pick on the card", async () => {
    const todo: ThreadTodo = {
      ...card,
      action: { type: "start_thread", prompt: "Run the focused suite", backend: "acp:antigravity" },
      dispatchDefaults: { thread, threadExecutionMode: "full-access" },
    };
    const { api } = setup({ todo, local: [{ ...claude, executionModes: modes("default", "full-access") }, antigravity] });
    await settle();
    expect(accessChip().getAttribute("aria-label")).toBe("Access for the new thread: Auto");
    expect(screen.getByTestId("todo-dispatch-access-note").textContent)
      .toBe("Antigravity has no Full Access, so the thread starts at Auto.");
    await act(async () => { fireEvent.click(accessChip()); });
    const menu = screen.getByRole("menu", { name: "Access for the new thread" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Default", "Accept Edits", "Auto", "Plan"]);
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitemradio", { name: /^Plan/ })); });
    expect(api.setThreadTodoAccess).toHaveBeenCalledWith({
      id: "card", executionMode: "default", nativeAccessMode: { backend: "acp:antigravity", id: "plan" },
    });
  });

  it("says when the destination offers neither the inherited access nor Default Access, and holds Start until one is chosen", async () => {
    const todo: ThreadTodo = {
      ...card,
      action: { type: "start_thread", prompt: "Run the focused suite", backend: "codex" },
      dispatchDefaults: { thread, threadExecutionMode: "auto" },
    };
    const { api } = setup({ todo, local: [claude, codex({ executionModes: modes("full-access") })] });
    await settle();
    expect(accessChip().getAttribute("aria-label")).toBe("Access for the new thread: Choose access");
    expect(screen.getByTestId("todo-dispatch-access-note").textContent)
      .toBe("OpenAI cannot use the inherited access mode or Default Access. Choose one of its modes.");
    expect(startButton().disabled).toBe(true);
    await act(async () => { fireEvent.click(accessChip()); });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("menu", { name: "Access for the new thread" }))
        .getByRole("menuitemradio", { name: /^Full Access/ }));
    });
    expect(api.setThreadTodoAccess).toHaveBeenCalledWith({ id: "card", executionMode: "full-access" });
  });

  it("shows an older owner's card at its own mode, never holding Start for rules that owner does not apply", async () => {
    // The card names Auto, which this catalog does not list. An owner
    // without thread_todo_access passes it through, as it always did.
    const todo: ThreadTodo = {
      ...card,
      id: "remote-todo:win:card",
      federationTarget: { scope: "remote", instanceId: "win" },
      action: { type: "start_thread", prompt: "Run the focused suite", executionMode: "auto" },
      dispatchDefaults: { thread: { backend: "codex", model: "sol" }, threadExecutionMode: "default" },
    };
    setup({ todo, instances: [WIN], win: [codex({ executionModes: modes("default", "full-access") })] });
    await settle();
    const chipLabel = accessChip();
    expect(chipLabel.tagName).toBe("SPAN");
    expect(chipLabel.getAttribute("aria-label")).toBe("Access for the new thread: Auto");
    expect(chipLabel.getAttribute("data-tooltip")).toBe("Update PwrAgent on win-lab / dev to choose access here.");
    expect(screen.queryByTestId("todo-dispatch-access-note")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it("holds Start after a pick until the card's saved version arrives", async () => {
    const todo: ThreadTodo = { ...card, dispatchDefaults: { thread, threadExecutionMode: "default" } };
    const { api, rerender, tree } = setup({
      todo, local: [{ ...claude, executionModes: modes("default", "auto", "full-access") }, codex()],
    });
    const saved: ThreadTodo = {
      ...todo, updatedAt: 1,
      action: { type: "start_thread", prompt: "Run the focused suite", executionMode: "full-access" },
    };
    api.setThreadTodoAccess.mockResolvedValue({ todo: saved });
    await settle();
    await act(async () => { fireEvent.click(accessChip()); });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("menu", { name: "Access for the new thread" }))
        .getByRole("menuitemradio", { name: /^Full Access/ }));
    });
    await settle();
    // The save answered, but this window still shows the Default Access card.
    expect(startButton().disabled).toBe(true);
    rerender(tree(saved));
    await settle();
    expect(startButton().disabled).toBe(false);
    expect(accessChip().getAttribute("aria-label")).toBe("Access for the new thread: Full Access");
  });
});
