import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendSummary,
  FederationTarget,
  ListBackendsRequest,
  ListThreadTodoDispatchEnvironmentsRequest,
  ListThreadTodoDispatchEnvironmentsResponse,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationThreadSummary,
  ThreadTodo,
} from "@pwragent/shared";
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
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Machine", "Model", "Where", "Env"]);
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
      "Model for the new thread: Claude, Opus 5.5, high",
      "Where the new thread works: This thread's directory",
      "Environment for the new thread: Dev",
      "Show start settings",
    ]);
    expect(chip("Machine for the new thread").getAttribute("data-tooltip")).toBe("Machine: studio");
    expect(chip("Where the new thread works").getAttribute("data-tooltip")).toBe("Where: This thread's directory");
    expect(chip("Environment for the new thread").getAttribute("data-tooltip")).toBe("Environment: Dev");
    expect(container.querySelector("dt")).toBeNull();
    expect(chip("Machine for the new thread").getAttribute("aria-label")).toBe("Machine for the new thread: studio");
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high");
    expect(chip("Where the new thread works").textContent).toBe("This thread's directory");
    expect(chip("Environment for the new thread").textContent).toBe("Dev");
    expect(api.listThreadTodoDispatchEnvironments).toHaveBeenCalledWith({ id: "card" });
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
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: OpenAI, GPT-6.1-Sol, high");
    expect(screen.getByText("Claude is not set up on win-lab / dev. Using another provider.")).toBeTruthy();
    expect(chip("Where the new thread works").textContent).toBe("atlas checkout");
    expect(chip("Environment for the new thread").textContent).toBe("Windows CI");
    // A peer start carries fast mode only, so Ultrafast is not offered there.
    await act(async () => { fireEvent.click(chip("Speed for the new thread")); });
    const speeds = within(screen.getByRole("menu", { name: "Speed for the new thread" }));
    expect(speeds.getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["Standard", "Fast"]);
    await act(async () => { fireEvent.click(speeds.getByRole("menuitemradio", { name: "Fast" })); });
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
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high");
    expect(screen.queryByRole("button", { name: /^Speed for the new thread/ })).toBeNull();
    expect(chip("Environment for the new thread").textContent).toBe("Dev");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, { modelSettings: thread, workMode: "worktree", environment: "dev" });

    // The peer's choices are still there when the card goes back to it.
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    expect(chip("Speed for the new thread").textContent).toBe("Fast");
  });

  it("keeps a model picked for the peer on the peer only", async () => {
    const { onRun } = setup({ win: [codex(), { ...claude, launchpadOptions: { models: [
      { id: "sonnet", label: "Sonnet 5.5", current: true, reasoningEfforts: ["medium"] },
    ] } } as BackendSummary] });
    await settle();
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    // Claude is there, without Opus: the provider stays and its default model is used.
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Sonnet 5.5, medium");
    expect(screen.getByText("Claude · Opus 5.5 is not offered on win-lab / dev. Using its default model.")).toBeTruthy();
    await act(async () => { fireEvent.click(chip("Model for the new thread")); });
    const menu = screen.getByRole("menu", { name: "Model for the new thread" });
    // This thread's own settings cannot run there, so the row is left out.
    expect(within(menu).queryByRole("menuitemradio", { name: /This thread/ })).toBeNull();
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitem", { name: "To-do provider: Claude" })); });
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "OpenAI" })); });
    if (screen.queryByRole("menu", { name: "Model for the new thread" })) {
      await act(async () => { fireEvent.click(chip("Model for the new thread")); });
    }
    await choose("Machine for the new thread", "studio");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(onRun).toHaveBeenLastCalledWith(card, { modelSettings: thread, environment: "dev" });
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: OpenAI, GPT-6.1-Sol, high");
  });

  it("locks Speed at Standard when the chosen machine turned Fast off", async () => {
    setup({ win: [codex({ codexFastAllowed: false })] });
    await settle();
    await choose("Machine for the new thread", "win-lab / dev");
    await settle();
    const speed = chip("Speed for the new thread");
    // Standard is the composer's bare bolt; its name and tooltip say which.
    expect(speed.getAttribute("aria-label")).toBe("Speed for the new thread: Standard");
    expect(speed.textContent).toBe("");
    expect(speed.className).toContain("is-icon-only");
    expect(speed.hasAttribute("disabled")).toBe(true);
    expect(speed.getAttribute("data-tooltip")).toBe("Fast mode is turned off in Settings → Models on win-lab / dev.");
  });

  it("follows this machine's Allow Fast mode setting for a Codex thread, and inherits its speed when allowed", async () => {
    const todo = { ...card, backend: "codex" as const, dispatchDefaults: {
      thread: { backend: "codex" as const, model: "sol", reasoningEffort: "high" }, threadSpeed: { fastMode: true },
    } };
    const { onRun, unmount } = setup({ todo, localCodexFastAllowed: false });
    await settle();
    expect(chip("Speed for the new thread").getAttribute("aria-label")).toBe("Speed for the new thread: Standard");
    expect(chip("Speed for the new thread").getAttribute("data-tooltip")).toBe("Fast mode is turned off in Settings → Models.");
    unmount();

    const allowed = setup({ todo });
    await settle();
    expect(chip("Speed for the new thread").textContent).toBe("Fast");
    // A paid tier is named and lit, as the composer draws it.
    expect(chip("Speed for the new thread").className).toContain("is-lit");
    expect(chip("Speed for the new thread").className).not.toContain("is-changed");
    // Ultrafast is offered on the card's own machine.
    await act(async () => { fireEvent.click(chip("Speed for the new thread")); });
    expect(within(screen.getByRole("menu", { name: "Speed for the new thread" })).getAllByRole("menuitemradio")
      .map((row) => row.textContent)).toEqual(["Standard", "Fast", "Ultrafast"]);
    await act(async () => { fireEvent.click(chip("Speed for the new thread")); });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    // Unchanged, the owner inherits the thread's exact speed.
    expect(allowed.onRun).toHaveBeenLastCalledWith(todo, expect.not.objectContaining({ speed: expect.anything() }));
    await choose("Speed for the new thread", "Standard");
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
    expect(screen.queryByRole("button", { name: /^Speed for the new thread/ })).toBeNull();
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
    expect(chip("Model for the new thread").getAttribute("aria-label")).toBe("Model for the new thread: Claude, Opus 5.5, high");
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
