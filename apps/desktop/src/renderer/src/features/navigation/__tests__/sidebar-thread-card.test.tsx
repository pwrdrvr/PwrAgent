import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApplicationsSnapshot } from "@pwragent/shared/contracts/settings";
import {
  beginNativeDragInteraction,
  endNativeDragInteraction,
} from "../../../lib/native-drag-interaction";
import { NavigationContextWindows } from "../../../lib/navigation-context-windows";
import { POINTER_AIM_SETTLE_MS } from "../../../lib/pointer-aim";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { PROJECT_CARD_HOVER_DELAY_MS } from "../ProjectHeaderCard";

/** Thread rows read by the archive-group count: the walk over the whole list. */
const archiveWalk = { rows: 0 };

vi.mock("../archive-group-counts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../archive-group-counts")>();
  return {
    ...original,
    countArchiveGroup: (...args: Parameters<typeof original.countArchiveGroup>) => {
      archiveWalk.rows += args[1].length;
      return original.countArchiveGroup(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as { pwragent?: unknown }).pwragent;
});

beforeEach(() => {
  vi.useFakeTimers();
  mockSidebarLayout();
});

function pr(number: number): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
  };
}

function thread(id: string, overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    createdAt: 1,
    updatedAt: 1,
    inbox: { inInbox: false, reason: "new-thread" },
    linkedDirectories: [],
    ...overrides,
  };
}

const CODEX_BACKEND = {
  kind: "codex",
  label: "Codex",
  available: true,
  methods: [],
  capabilities: { archiveThread: true, interruptTurn: true },
  executionModes: [],
} as unknown as BackendSummary;

const APPLICATIONS = {
  editors: [
    { id: "vscode", kind: "editor", name: "VS Code", source: "discovered", canOpenWorkspace: true },
    { id: "cursor", kind: "editor", name: "Cursor", source: "discovered", canOpenWorkspace: true },
  ],
  terminals: [{ id: "ghostty", kind: "terminal", name: "Ghostty", source: "discovered", canOpenWorkspace: true }],
  preferredEditorId: { value: "vscode", source: "default" },
  preferredTerminalId: { value: "ghostty", source: "default" },
} as unknown as DesktopApplicationsSnapshot;

/**
 * The 440px sidebar (project index shown) with every row along its width
 * and the card beside it, 10px past its edge: the layout the card is built
 * for. jsdom has no layout, so this is what `cardIsBesideSidebar` reads.
 */
function mockSidebarLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("sidebar")) return new DOMRect(0, 0, 440, 900);
    if (this.classList.contains("pr-status-card")) return new DOMRect(450, 100, 312, 320);
    if (this.classList.contains("tooltip-hover-bridge")) return new DOMRect(440, 100, 10, 320);
    return new DOMRect(8, 120, 424, 56);
  });
}

type SidebarParams = {
  threads: NavigationThreadSummary[];
  backends?: BackendSummary[];
  remoteBackends?: ReadonlyMap<string, readonly BackendSummary[]>;
  onStopThread?: (thread: NavigationThreadSummary) => Promise<void>;
  onArchiveThread?: (thread: NavigationThreadSummary) => Promise<void>;
  onMarkThreadsSeen?: (threads: NavigationThreadSummary[]) => Promise<void>;
  onSetThreadPin?: (thread: NavigationThreadSummary, pinned: boolean) => Promise<void>;
  onRevealPath?: (path: string, label: string) => void;
  onSelectThread?: (thread: NavigationThreadSummary) => void;
  onOpenThreadTerminal?: (threadKey: string, cwd?: string, remote?: unknown) => void;
  applications?: DesktopApplicationsSnapshot;
  contextWindows?: NavigationContextWindows;
  selectedItemKey?: string;
  readOpenThreadContext?: () => { threadKey: string; totalTokens: number; modelContextWindow: number };
};

function renderSidebar(params: SidebarParams) {
  return render(sidebarElement(params));
}

function sidebarElement(params: SidebarParams) {
  return (
    <Sidebar
      backends={params.backends ?? [CODEX_BACKEND]}
      remoteBackends={params.remoteBackends}
      browseMode="inbox"
      directories={[]}
      inboxThreads={params.threads}
      loading={false}
      threads={params.threads}
      localApplications={params.applications}
      contextWindows={params.contextWindows}
      selectedItemKey={params.selectedItemKey}
      readOpenThreadContext={params.readOpenThreadContext}
      localMachineLabel="Studio-Mac"
      platform="darwin"
      onBrowseModeChange={() => undefined}
      onStopThread={params.onStopThread}
      onArchiveThread={params.onArchiveThread}
      onCreateThread={async () => undefined}
      onMarkThreadsSeen={params.onMarkThreadsSeen}
      onOpenLaunchpad={async () => undefined}
      onRevealPath={params.onRevealPath}
      onSelectThread={params.onSelectThread ?? (() => undefined)}
      onOpenThreadTerminal={params.onOpenThreadTerminal}
      onSetThreadPin={params.onSetThreadPin}
    />
  );
}

function row(id: string): HTMLElement {
  const shell = document.querySelector<HTMLElement>(`.thread-row-shell[data-thread-key="codex:${id}"]`);
  if (!shell) throw new Error(`No row for ${id}`);
  return shell.querySelector<HTMLElement>(".thread-row")!;
}

function rowTitle(id: string): HTMLElement {
  return row(id).querySelector<HTMLElement>(".thread-row__title")!;
}

/**
 * The pointer moves from `from` to `to`, as the browser reports it: a
 * `mouseout` naming where it went, then a `mouseover` naming where it came
 * from. Never `mouseEnter`, which re-enters the whole ancestry and hides a
 * leave between the two.
 */
function move(from: Element, to: Element): void {
  fireEvent.mouseOut(from, { relatedTarget: to });
  fireEvent.mouseOver(to, { relatedTarget: from });
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".sidebar-thread-card");
}

function hoverOpen(id: string): HTMLElement {
  move(document.querySelector(".sidebar")!, rowTitle(id));
  act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
  const shown = card();
  if (!shown) throw new Error("The card did not open");
  return shown;
}

describe("sidebar thread card", () => {
  it("opens after the project card's hover delay, with the row's facts", () => {
    renderSidebar({
      threads: [thread("a", {
        gitBranch: "fix/table-header",
        model: "gpt-6",
        reasoningEffort: "high",
        linkedDirectories: [{ id: "d", label: "PwrAgnt", path: "/src/PwrAgnt", kind: "local" }],
      })],
    });
    move(document.querySelector(".sidebar")!, rowTitle("a"));
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS - 1));
    expect(card()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const shown = card()!;
    expect(shown).toHaveTextContent("Thread a");
    expect(shown).toHaveTextContent("Idle · Codex");
    expect(shown).toHaveTextContent("PwrAgnt");
    expect(shown).toHaveTextContent("Studio-Mac");
    expect(shown).toHaveTextContent("this machine");
    expect(shown).toHaveTextContent("fix/table-header");
    expect(shown).toHaveTextContent("gpt-6 · high");
    expect(shown).not.toHaveTextContent("Context");
  });

  it.each([
    ["other", { totalTokens: 250, modelContextWindow: 1_000 }, "25%"],
    ["open", { totalTokens: 250, modelContextWindow: 1_000 }, "25%"],
    ["open", undefined, "60%"],
    ["other", undefined, undefined],
  ] as const)("uses the row's own context or its matching open session (%s, %j)", (id, contextWindow, percent) => {
    renderSidebar({
      threads: ["open", "other"].map((key) => thread(key, key === id ? { contextWindow } : {})),
      selectedItemKey: "codex:open",
      readOpenThreadContext: () => ({ threadKey: "codex:open", totalTokens: 600, modelContextWindow: 1_000 }),
    });
    const shown = hoverOpen(id);
    if (percent) {
      expect(shown).toHaveTextContent(percent);
      expect(shown.querySelector(".thread-info-card__context-used")).toHaveStyle({ width: percent });
    } else {
      expect(shown).not.toHaveTextContent("Context");
    }
  });

  it("updates a visible meter only for the hovered identity and reads earlier events on open", () => {
    const contextWindows = new NavigationContextWindows();
    const observe = (id: string, usedTokens: number) => act(() => contextWindows.observe(`codex:${id}`, "codex", {
      method: "thread/contextWindow/updated", params: { threadId: id, usedTokens, modelContextWindow: 100 },
    }));
    renderSidebar({ threads: [thread("a"), thread("b")], selectedItemKey: "codex:b", contextWindows });
    observe("a", 25);
    const shown = hoverOpen("a");
    expect(shown).toHaveTextContent("25%");
    observe("b", 80);
    expect(shown).toHaveTextContent("25%");
    observe("a", 60);
    expect(shown.querySelector(".thread-info-card__context-used")).toHaveStyle({ width: "60%" });
  });

  it("opens at once on keyboard focus, and not on a click's or a script's focus", () => {
    renderSidebar({ threads: [thread("a"), thread("b")] });
    const open = row("a").querySelector<HTMLElement>(".thread-row__open")!;
    fireEvent.keyDown(open, { key: "ArrowDown" });
    fireEvent.pointerDown(open);
    fireEvent.focusIn(open);
    expect(card()).toBeNull();
    // Escape out of a rename hands focus back to the row: not an arrival.
    fireEvent.keyDown(open, { key: "Escape" });
    fireEvent.focusIn(open);
    expect(card()).toBeNull();
    fireEvent.focusOut(open);
    const next = row("b").querySelector<HTMLElement>(".thread-row__open")!;
    fireEvent.keyDown(open, { key: "ArrowDown" });
    fireEvent.focusIn(next);
    expect(card()).toHaveTextContent("Thread b");
    fireEvent.focusOut(next, { relatedTarget: document.body });
    expect(card()).toBeNull();
  });

  // Oracle: the card is enterable. From a row, the pointer may cross the
  // row's own chips and any number of the rows below on its way out of the
  // sidebar; each row it crosses swaps the card at once, and the bridge
  // across the gap then lands on the card, which stays.
  it("stays open across the next rows, the row's own PR chip, and the gap", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 3 }), { maxLength: 3 }),
      fc.boolean(),
      fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 8, maxLength: 8 }),
      (crossed, viaChip, dwell) => {
        mockSidebarLayout();
        const ids = ["a", "b", "c", "d"];
        const { unmount } = renderSidebar({
          threads: ids.map((id, index) => thread(id, { updatedAt: 10 - index, prs: [pr(100 + index)] })),
        });
        try {
          hoverOpen("a");
          const hops: Element[] = [rowTitle("a")];
          if (viaChip) hops.push(row("a").querySelector("[data-pr-chip]")!, rowTitle("a"));
          for (const index of crossed) hops.push(rowTitle(ids[index]!));
          const last = hops.at(-1)!.closest(".thread-row-shell")!.getAttribute("data-thread-key")!;
          const shown = card()!;
          hops.push(shown.querySelector(".tooltip-hover-bridge")!, shown);
          for (let index = 1; index < hops.length; index += 1) {
            move(hops[index - 1]!, hops[index]!);
            act(() => vi.advanceTimersByTime(dwell[index - 1]!));
            expect(card()).not.toBeNull();
          }
          act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 2));
          expect(card()).toHaveTextContent(`Thread ${last.replace("codex:", "")}`);
          // Only one sidebar card: crossing the PR chip did not open its own.
          expect(document.querySelectorAll(".pr-status-card")).toHaveLength(1);
        } finally {
          unmount();
          vi.restoreAllMocks();
        }
      },
    ), {
      // A rendered fixture: the budget is 5 generated routes plus the named
      // ones below. The bridge rule itself is a pure property in
      // hover-card-bridge.holds.test.ts.
      numRuns: 5,
      examples: [
        // Found without `HoverCardBridge.holds`: crossing the row's own PR
        // chip swapped the thread card for the PR card on the way to it.
        [[], true, [0, 0, 0, 0, 0, 0, 0, 0]],
        // Every row below, each dwelt on, then the gap.
        [[1, 2, 3], false, [60, 60, 60, 60, 60, 60, 60, 60]],
        // The chip, then the next row, with no dwell anywhere.
        [[1], true, [0, 0, 0, 0, 0, 0, 0, 0]],
      ],
    });
  });

  describe("a pointer heading for the card", () => {
    // The card is at x 450..762, y 100..420. From row a's title at (100, 140),
    // (200, 200) lies inside the triangle to the card's near edge; (60, 200)
    // does not.
    function startAt(): void {
      for (const x of [96, 98, 100]) fireEvent.mouseMove(rowTitle("a"), { clientX: x, clientY: 140 });
    }
    function cross(from: Element, to: Element, x: number, y: number): void {
      fireEvent.mouseOut(from, { relatedTarget: to, clientX: x, clientY: y });
      fireEvent.mouseOver(to, { relatedTarget: from, clientX: x, clientY: y });
      fireEvent.mouseMove(to, { clientX: x, clientY: y });
    }

    it("keeps the card across a row it crosses on the way, chips included", () => {
      renderSidebar({ threads: [thread("a", { updatedAt: 3 }), thread("b", { updatedAt: 2, prs: [pr(9)] })] });
      hoverOpen("a");
      startAt();
      cross(rowTitle("a"), rowTitle("b"), 200, 200);
      // The crossed row's own PR chip is on the way too (found in a real
      // layout: the diagonal to the card ran through it and swapped cards).
      const chip = row("b").querySelector("[data-pr-chip]")!;
      cross(rowTitle("b"), chip, 210, 206);
      act(() => vi.advanceTimersByTime(POINTER_AIM_SETTLE_MS - 20));
      expect(document.querySelectorAll(".pr-status-card")).toHaveLength(1);
      const shown = card()!;
      move(chip, shown.querySelector(".tooltip-hover-bridge")!);
      move(shown.querySelector(".tooltip-hover-bridge")!, shown);
      act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 2));
      expect(card()).toHaveTextContent("Thread a");
    });

    it("gives the card to the crossed row once the pointer stops there", () => {
      renderSidebar({ threads: [thread("a", { updatedAt: 3 }), thread("b", { updatedAt: 2 })] });
      hoverOpen("a");
      startAt();
      cross(rowTitle("a"), rowTitle("b"), 200, 200);
      expect(card()).toHaveTextContent("Thread a");
      act(() => vi.advanceTimersByTime(POINTER_AIM_SETTLE_MS));
      expect(card()).toHaveTextContent("Thread b");
    });

    it("gives the card to the crossed row at once when the pointer turns away", () => {
      renderSidebar({ threads: [thread("a", { updatedAt: 3 }), thread("b", { updatedAt: 2 })] });
      hoverOpen("a");
      startAt();
      cross(rowTitle("a"), rowTitle("b"), 200, 200);
      fireEvent.mouseMove(rowTitle("b"), { clientX: 60, clientY: 210 });
      expect(card()).toHaveTextContent("Thread b");
    });
  });

  it("closes after the grace when the pointer leaves for anywhere but the card", () => {
    renderSidebar({ threads: [thread("a")] });
    hoverOpen("a");
    move(rowTitle("a"), document.body);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS - 1));
    expect(card()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(card()).toBeNull();
  });

  it("lets a PR chip on its row open the PR card after the chip's own delay", () => {
    renderSidebar({ threads: [thread("a", { prs: [pr(7)] })] });
    hoverOpen("a");
    const chip = row("a").querySelector("[data-pr-chip]")!;
    move(rowTitle("a"), chip);
    expect(card()).not.toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(card()).toBeNull();
    expect(screen.getByRole("tooltip")).toHaveTextContent("acme/orbit#7");
  });

  // Found by E2E: a click on a row opened its thread, then the card came up
  // over the transcript 600 ms later and took the next click.
  it("never opens for a row pressed during the hover delay", () => {
    renderSidebar({ threads: [thread("a"), thread("b")] });
    move(document.querySelector(".sidebar")!, rowTitle("a"));
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS / 2));
    fireEvent.pointerDown(rowTitle("a"));
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(card()).toBeNull();
    // A quick click: the press lands in the same frame as the pointer, before
    // React commits anything for the arrival.
    act(() => {
      move(rowTitle("a"), rowTitle("b"));
      fireEvent.pointerDown(rowTitle("b"));
    });
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(card()).toBeNull();
  });

  // Found in the pin-drag E2E: the dragged row crossed another, whose delayed
  // card crashed the sidebar mid-drag and cancelled the drop.
  it("opens no card for a row a sidebar drag passes over", () => {
    renderSidebar({ threads: [thread("a"), thread("b")] });
    try {
      act(() => beginNativeDragInteraction());
      move(document.querySelector(".sidebar")!, rowTitle("a"));
      move(rowTitle("a"), rowTitle("b"));
      act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
      expect(card()).toBeNull();
      expect(row("b")).toBeInTheDocument();
    } finally {
      act(() => endNativeDragInteraction());
    }
    // The next hover after the drop opens as usual.
    move(rowTitle("b"), rowTitle("a"));
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(card()).toHaveTextContent("Thread a");
  });

  // Found in a real layout: a pointer that lands on the chip from outside
  // got the PR card at 250 ms, then lost it to the row's card at 600 ms.
  it("leaves the PR card up for a pointer that came straight to the chip", () => {
    renderSidebar({ threads: [thread("a", { prs: [pr(7)] })] });
    const chip = row("a").querySelector("[data-pr-chip]")!;
    move(document.querySelector(".sidebar")!, chip);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.getByRole("tooltip")).toHaveTextContent("acme/orbit#7");
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(card()).toBeNull();
    expect(screen.getByRole("tooltip")).toHaveTextContent("acme/orbit#7");
  });

  it("calls the row menu's handlers from its buttons", async () => {
    const onMarkThreadsSeen = vi.fn(async () => undefined);
    const onArchiveThread = vi.fn(async () => undefined);
    const onSetThreadPin = vi.fn(async () => undefined);
    renderSidebar({
      threads: [thread("a", { inbox: { inInbox: true, reason: "new-thread" } })],
      onMarkThreadsSeen,
      onArchiveThread,
      onSetThreadPin,
    });
    let shown = hoverOpen("a");
    fireEvent.click(within(shown).getByRole("button", { name: "Pin thread", hidden: true }));
    expect(onSetThreadPin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), true);
    fireEvent.click(within(shown).getByRole("button", { name: "Mark read", hidden: true }));
    await act(async () => undefined);
    expect(onMarkThreadsSeen).toHaveBeenCalledWith([expect.objectContaining({ id: "a" })]);
    expect(card()).toBeNull();

    shown = hoverOpen("a");
    fireEvent.click(within(shown).getByRole("button", { name: /Archive/, hidden: true }));
    await act(async () => undefined);
    expect(onArchiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    shown = hoverOpen("a");
    fireEvent.click(within(shown).getByRole("button", { name: "More thread actions", hidden: true }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(card()).toBeNull();
  });

  // Found by the scaling audit: every hover, and every navigation update
  // while a card was up, walked the whole thread list for its sub-threads.
  it("walks no thread list to open a card or keep it current", async () => {
    const threads = [thread("a"), thread("b"), thread("c")];
    const onArchiveThread = vi.fn(async () => undefined);
    const view = renderSidebar({ threads, onArchiveThread });
    archiveWalk.rows = 0;
    const shown = hoverOpen("a");
    const updated = [thread("a", { contextWindow: { totalTokens: 40, modelContextWindow: 100 } }), ...threads.slice(1)];
    view.rerender(sidebarElement({ threads: updated, onArchiveThread }));
    expect(card()).toHaveTextContent("Context 40 of 100");
    expect(archiveWalk.rows).toBe(0);
    // Archiving checks the loaded rows once, for a sub-thread the count missed.
    fireEvent.click(within(shown).getByRole("button", { name: /Archive/, hidden: true }));
    await act(async () => undefined);
    expect(archiveWalk.rows).toBe(3);
    expect(onArchiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("leaves a parent's two archives to its menu", async () => {
    // The owner's count, as loaded navigation rows carry it.
    const counted = { ordinaryChildCount: 1 } as Partial<NavigationThreadSummary>;
    renderSidebar({
      threads: [thread("a", counted), thread("b", { parentThreadId: "a" })],
      onArchiveThread: async () => undefined,
    });
    let shown = hoverOpen("a");
    expect(within(shown).queryByRole("button", { name: /^Archive/, hidden: true })).toBeNull();
    expect(within(shown).getByRole("button", { name: "More thread actions", hidden: true })).toBeInTheDocument();
    cleanup();

    // A sub-thread loaded before its parent's count caught up: the card's
    // Archive finds it and offers the menu's two archives instead.
    const onArchiveThread = vi.fn(async () => undefined);
    renderSidebar({ threads: [thread("a"), thread("b", { parentThreadId: "a" })], onArchiveThread });
    shown = hoverOpen("a");
    fireEvent.click(within(shown).getByRole("button", { name: /^Archive/, hidden: true }));
    await act(async () => undefined);
    expect(onArchiveThread).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("swaps Mark read and Archive for Stop while the thread runs", () => {
    const idle = thread("a", { inbox: { inInbox: true, reason: "new-thread" } });
    const active = thread("a", { ...idle, threadStatus: "active" });
    const onStopThread = vi.fn(async () => undefined);
    const params = {
      threads: [idle],
      onMarkThreadsSeen: async () => undefined,
      onArchiveThread: async () => undefined,
      onStopThread,
    };
    const view = renderSidebar(params);
    const shown = hoverOpen("a");
    expect(within(shown).queryByRole("button", { name: "Stop", hidden: true })).toBeNull();
    const running = { ...params, threads: [active] };
    const noInterrupt = { ...CODEX_BACKEND, capabilities: { ...CODEX_BACKEND.capabilities, interruptTurn: false } };
    view.rerender(sidebarElement({ ...running, backends: [noInterrupt] }));
    expect(within(shown).queryByRole("button", { name: "Stop", hidden: true })).toBeNull();
    view.rerender(sidebarElement(running));
    expect(shown).toHaveTextContent("Running · Codex");
    expect(within(shown).queryByRole("button", { name: "Mark read", hidden: true })).toBeNull();
    expect(within(shown).queryByRole("button", { name: /Archive/, hidden: true })).toBeNull();
    fireEvent.click(within(shown).getByRole("button", { name: "Stop", hidden: true }));
    expect(onStopThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a", source: "codex" }));
    expect(card()).toBeNull();
  });

  it("stops the focused row from its keyboard menu", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onStopThread = vi.fn(async () => undefined);
    renderSidebar({ threads: [thread("a", { threadStatus: "active" })], onStopThread });
    const trigger = row("a").querySelector<HTMLButtonElement>(".thread-row__open")!;
    trigger.focus();
    fireEvent.contextMenu(trigger); // Native context-menu key on the focused row.
    const menu = screen.getByRole("menu");
    const stop = within(menu).getByRole("menuitem", { name: "Stop" });
    await user.keyboard("{Home}");
    const itemCount = menu.querySelectorAll('[role^="menuitem"]').length;
    for (let i = 0; document.activeElement !== stop && i < itemCount; i++) {
      await user.keyboard("{ArrowDown}");
    }
    expect(stop).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onStopThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a", source: "codex" }));
    expect(menu).not.toBeInTheDocument();
  });

  it.each([
    { grant: false, available: true, interrupt: true, allowed: false },
    { grant: true, available: false, interrupt: true, allowed: false },
    { grant: true, available: true, interrupt: false, allowed: false },
    { grant: true, available: true, interrupt: true, allowed: true },
  ])("gates both Stop actions on the peer grant ($grant) and owner backend ($available, $interrupt)", ({ grant, available, interrupt, allowed }) => {
    const onStopThread = vi.fn(async () => undefined);
    const peer = thread("a", {
      threadStatus: "active",
      federation: {
        ref: { target: { scope: "remote", instanceId: "lab" }, backend: "codex", threadId: "a" },
        instanceLabel: "lab-mini",
        peerStatus: "connected",
        capabilities: grant ? ["turn_control"] : [],
      },
    });
    const ownerBackend = { ...CODEX_BACKEND, available, capabilities: { ...CODEX_BACKEND.capabilities, interruptTurn: interrupt } };
    renderSidebar({ threads: [peer], remoteBackends: new Map([["lab", [ownerBackend]]]), onStopThread });
    move(document.querySelector(".sidebar")!, document.querySelector(".thread-row__title")!);
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    const shown = card()!;
    expect(shown).toHaveTextContent("Running ·");
    const button = { name: "Stop", hidden: true };
    if (allowed) {
      fireEvent.click(within(shown).getByRole("button", button));
      expect(onStopThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ federation: peer.federation }));
    } else {
      expect(within(shown).queryByRole("button", button)).toBeNull();
    }
    fireEvent.contextMenu(document.querySelector(".thread-row__open")!);
    const menuStop = within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Stop" });
    expect(Boolean(menuStop)).toBe(allowed);
  });

  const WORKTREE_THREAD: Partial<NavigationThreadSummary> = {
    linkedDirectories: [
      { id: "w", label: "PwrAgnt", path: "/src/PwrAgnt", worktreePath: "/wt/PwrAgnt", kind: "worktree" },
      { id: "t", label: "t3code", path: "/src/t3code", kind: "local" },
    ],
    projectKey: "/wt/PwrAgnt",
  };

  function iconRow(shown: HTMLElement): HTMLButtonElement[] {
    return [...shown.querySelectorAll<HTMLButtonElement>(".sidebar-thread-card__actions button")];
  }

  it("lays out one icon row: open icons, then the thread's own actions", () => {
    (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn(async () => ({})) };
    renderSidebar({
      applications: APPLICATIONS,
      threads: [thread("a", { ...WORKTREE_THREAD, gitBranch: "fix/x", prs: [pr(7)], inbox: { inInbox: true, reason: "new-thread" } })],
      onMarkThreadsSeen: async () => undefined,
      onArchiveThread: async () => undefined,
      onSetThreadPin: async () => undefined,
      onRevealPath: () => undefined,
      onOpenThreadTerminal: () => undefined,
    });
    const shown = hoverOpen("a");
    // The fifth open target, Cursor, waits in the ⋯ menu.
    expect(iconRow(shown).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open in VS Code",
      "Open in Ghostty",
      "Open terminal here",
      "Show in Finder",
      "Pin thread",
      "Mark read",
      "Archive thread",
      "More thread actions",
    ]);
    for (const button of iconRow(shown)) {
      // Icon-only, named by its tooltip.
      expect(button).toHaveAttribute("data-tooltip", button.getAttribute("aria-label"));
      expect(button).toHaveClass("tooltip-target");
      expect(button.textContent).toBe("");
    }
    // The text rows are gone: the fact rows copy the branch and show the PR.
    expect(within(shown).queryByRole("button", { name: "Copy branch name", hidden: true })).toBeNull();
    expect(within(shown).queryByRole("button", { name: "Open pull request", hidden: true })).toBeNull();
    expect(within(shown).queryByRole("button", { name: "Choose an app", hidden: true })).toBeNull();
  });

  // The keyboard model matches the project card's button row: the icons are
  // pointer shortcuts, and Tab moves from row to row without entering the
  // card; the row's own menu reaches every action.
  it("keeps the icon row out of the Tab order", () => {
    (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn(async () => ({})) };
    renderSidebar({
      applications: APPLICATIONS,
      threads: [thread("a", { ...WORKTREE_THREAD, updatedAt: 2 }), thread("b")],
      onArchiveThread: async () => undefined,
      onSetThreadPin: async () => undefined,
    });
    const open = row("a").querySelector<HTMLElement>(".thread-row__open")!;
    fireEvent.keyDown(open, { key: "Tab" });
    fireEvent.focusIn(open);
    const shown = card()!;
    expect(shown.querySelector(".sidebar-thread-card__actions")).toHaveAttribute("aria-hidden", "true");
    const tabbable = [...shown.querySelectorAll<HTMLElement>("button, [tabindex]")]
      .filter((element) => element.tabIndex >= 0);
    expect(tabbable).toEqual([]);
    expect(iconRow(shown).length).toBeGreaterThan(0);
  });

  it("opens the thread's primary folder from each open icon", () => {
    const openApplication = vi.fn(async () => ({}));
    (window as { pwragent?: unknown }).pwragent = { openApplication };
    const onRevealPath = vi.fn();
    const onSelectThread = vi.fn();
    const onOpenThreadTerminal = vi.fn();
    renderSidebar({
      applications: APPLICATIONS,
      threads: [thread("a", WORKTREE_THREAD)],
      onRevealPath,
      onSelectThread,
      onOpenThreadTerminal,
    });
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "Open in VS Code", hidden: true }));
    expect(openApplication).toHaveBeenLastCalledWith({ applicationId: "vscode", kind: "editor", targetPath: "/wt/PwrAgnt" });
    expect(card()).toBeNull();
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "Open in Ghostty", hidden: true }));
    expect(openApplication).toHaveBeenLastCalledWith({ applicationId: "ghostty", kind: "terminal", targetPath: "/wt/PwrAgnt" });
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "Show in Finder", hidden: true }));
    expect(onRevealPath).toHaveBeenCalledWith("/wt/PwrAgnt", "PwrAgnt");
    // The integrated terminal opens in the thread's view, so the thread opens first.
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "Open terminal here", hidden: true }));
    expect(onSelectThread).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onOpenThreadTerminal).toHaveBeenCalledWith("codex:a", "/wt/PwrAgnt", undefined);
    expect(onSelectThread.mock.invocationCallOrder[0]).toBeLessThan(onOpenThreadTerminal.mock.invocationCallOrder[0]!);
  });

  // Found in review: the card selected the thread without what a plain row
  // click does, so a multi-select batch outlived the new selection.
  it("opens the terminal's thread as a plain row click does: no batch left", () => {
    const threads = ["a", "b", "c"].map((id, index) =>
      thread(id, { updatedAt: 10 - index, inbox: { inInbox: true, reason: "new-thread" } }));
    renderSidebar({
      threads,
      selectedItemKey: "codex:a",
      onMarkThreadsSeen: async () => undefined,
      onOpenThreadTerminal: () => undefined,
    });
    const open = (id: string) => row(id).querySelector<HTMLElement>(".thread-row__open")!;
    fireEvent.click(open("b"), { metaKey: true, ctrlKey: true });
    fireEvent.contextMenu(open("a"));
    expect(screen.getByRole("menuitem", { name: "Mark 2 Threads Read" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(within(hoverOpen("c")).getByRole("button", { name: "Open terminal here", hidden: true }));
    fireEvent.contextMenu(open("a"));
    expect(screen.queryByRole("menuitem", { name: /Mark \d+ Threads Read/ })).toBeNull();
  });

  it("puts the open icons past four in the ⋯ menu's Open in…", () => {
    const openApplication = vi.fn(async () => ({}));
    (window as { pwragent?: unknown }).pwragent = { openApplication };
    renderSidebar({
      applications: APPLICATIONS,
      threads: [thread("a", WORKTREE_THREAD)],
      onRevealPath: () => undefined,
      onOpenThreadTerminal: () => undefined,
    });
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "More thread actions", hidden: true }));
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open in…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cursor" }));
    expect(openApplication).toHaveBeenLastCalledWith({ applicationId: "cursor", kind: "editor", targetPath: "/wt/PwrAgnt" });
    expect(screen.queryByRole("menu")).toBeNull();

    // Four or fewer leave the menu as it was; a right-click never has it.
    cleanup();
    renderSidebar({ applications: APPLICATIONS, threads: [thread("a", WORKTREE_THREAD)] });
    fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: "More thread actions", hidden: true }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Open in…" })).toBeNull();
  });

  function peerThread(id: string, instanceId = "lab"): NavigationThreadSummary {
    return thread(id, {
      gitBranch: "docs/rewrite",
      linkedDirectories: [{ id: "d", label: "mathathon", path: "/src/mathathon", worktreePath: "/wt/mathathon", kind: "worktree" }],
      federation: {
        ref: { target: { scope: "remote", instanceId }, backend: "codex", threadId: id },
        instanceLabel: `${instanceId}-mini`,
        peerStatus: "connected",
        capabilities: ["remote_window"],
      },
    });
  }

  function projectedRow(summary: NavigationThreadSummary) {
    return navigationQueryFixture(
      { protocol: 2, query: { kind: "lens", lens: "inbox" }, consumer: "main-sidebar", pageSize: 10 },
      { threads: [summary] },
    ).entries[0]!.row;
  }

  it("offers a peer's thread only what works on that peer", async () => {
    const openApplication = vi.fn(async () => ({}));
    const terminal = { ...APPLICATIONS.terminals[0]!, id: "peer-terminal" };
    const readApplications = vi.fn(async () => ({
      applications: {
        ...APPLICATIONS,
        terminals: [...APPLICATIONS.terminals, terminal],
        preferredTerminalId: { value: terminal.id, source: "config" },
      },
    }));
    (window as { pwragent?: unknown }).pwragent = { openApplication, readApplications, applicationWorkspaceExists: async () => true };
    const both = peerThread("b");
    both.federation!.capabilities = ["remote_window", "remote_pty"];
    renderSidebar({
      applications: APPLICATIONS,
      threads: [peerThread("a"), both],
      onOpenThreadTerminal: vi.fn(),
      onArchiveThread: async () => undefined,
      onRevealPath: vi.fn(),
    });
    move(document.querySelector(".sidebar")!, screen.getByText("Thread a"));
    expect(readApplications).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    const shown = card()!;
    expect(shown).toHaveTextContent("lab-mini");
    expect(shown).toHaveTextContent("peer");
    expect(within(shown).queryByRole("button", { name: /Open in|Show in Finder|Choose an app/, hidden: true })).toBeNull();
    expect(within(shown).queryByRole("button", { name: /Archive/, hidden: true })).toBeNull();
    expect(within(shown).getByRole("button", { name: "Copy branch name docs/rewrite", hidden: true })).toBeInTheDocument();
    fireEvent.click(within(shown).getByRole("button", { name: "Open terminal on lab-mini", hidden: true }));
    const federationTarget = { scope: "remote", instanceId: "lab" };
    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "peer-terminal", federationTarget, kind: "terminal", targetPath: "/wt/mathathon",
    });

    move(document.querySelector(".sidebar")!, screen.getByText("Thread b"));
    await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(within(card()!).getByRole("button", { name: "Open terminal on lab-mini", hidden: true })).toBeInTheDocument();
    expect(within(card()!).getByRole("button", { name: "Open terminal here", hidden: true })).toBeInTheDocument();
    expect(readApplications.mock.calls).toEqual([[{ federationTarget }]]);
  });

  it("gates the integrated peer terminal on remote_pty", () => {
    (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn() };
    const peerThread = (capabilities: string[]) => thread("a", {
      gitBranch: "docs/rewrite",
      linkedDirectories: [{ id: "d", label: "mathathon", path: "/src/mathathon", kind: "local" }],
      federation: {
        ref: { target: { scope: "remote", instanceId: "lab" }, backend: "codex", threadId: "a" },
        instanceLabel: "lab-mini",
        peerStatus: "connected",
        capabilities,
      } as unknown as NavigationThreadSummary["federation"],
    });
    const onOpenThreadTerminal = vi.fn();
    const hoverPeer = (): HTMLElement => {
      // A peer's row is keyed by its owner too; it is the only row here.
      move(document.querySelector(".sidebar")!, document.querySelector(".thread-row-shell .thread-row__title")!);
      act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
      return card()!;
    };
    renderSidebar({
      applications: APPLICATIONS,
      threads: [peerThread([])],
      onArchiveThread: async () => undefined,
      onRevealPath: () => undefined,
      onOpenThreadTerminal,
    });
    let shown = hoverPeer();
    expect(shown).toHaveTextContent("lab-mini");
    expect(shown).toHaveTextContent("peer");
    // This machine's apps and file manager cannot open a peer's folder, and
    // this peer withholds its terminal and turn_control (Archive).
    expect(iconRow(shown).map((button) => button.getAttribute("aria-label"))).toEqual(["More thread actions"]);
    expect(within(shown).getByRole("button", { name: "Copy branch name docs/rewrite", hidden: true })).toBeInTheDocument();
    cleanup();

    renderSidebar({
      applications: APPLICATIONS,
      threads: [peerThread(["remote_pty"])],
      onRevealPath: () => undefined,
      onOpenThreadTerminal,
    });
    shown = hoverPeer();
    expect(iconRow(shown).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open terminal here",
      "More thread actions",
    ]);
    fireEvent.click(within(shown).getByRole("button", { name: "Open terminal here", hidden: true }));
    expect(onOpenThreadTerminal).toHaveBeenCalledWith(
      "codex:a",
      undefined,
      expect.objectContaining({ instanceId: "lab", instanceLabel: "lab-mini" }),
    );
  });

  it("copies the branch from its fact row, with a hint and a brief Copied", async () => {
    const copy = vi.fn(async () => undefined);
    (window as { pwragent?: unknown }).pwragent = { copyText: copy };
    renderSidebar({ threads: [thread("a", { gitBranch: "fix/table-header" })] });
    const shown = hoverOpen("a");
    const branch = within(shown).getByRole("button", { name: "Copy branch name fix/table-header", hidden: true });
    // The glyph is in the row from the start; CSS shows it on hover or focus.
    expect(branch.querySelector(".thread-info-card__copy-hint")).not.toBeNull();
    fireEvent.click(branch);
    await act(async () => undefined);
    expect(copy).toHaveBeenCalledWith("fix/table-header");
    expect(branch).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1200));
    expect(branch).not.toHaveTextContent("Copied");
  });

  describe("the PR fact row", () => {
    function showRects(): void {
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        () => [new DOMRect(0, 0, 40, 16)] as unknown as DOMRectList,
      );
    }

    it("opens one PR's own card", () => {
      showRects();
      renderSidebar({ threads: [thread("a", { prs: [pr(7)] })] });
      const shown = hoverOpen("a");
      const fact = within(shown).getByRole("button", { name: "Open pull request #7", hidden: true });
      expect(fact).toHaveTextContent("#7 · ");
      fireEvent.click(fact);
      expect(document.activeElement).toBe(row("a").querySelector("[data-pr-chip]"));
    });

    it("shows several as the lead PR and +N, and opens the row's rollup card", () => {
      showRects();
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      renderSidebar({ threads: [thread("a", { prs: [pr(7), pr(8), pr(9)] })] });
      const shown = hoverOpen("a");
      const fact = within(shown).getByRole("button", { name: /^Show 3 pull requests, #\d+ leading$/, hidden: true });
      expect(fact.textContent).toMatch(/#\d+ \+2/);
      expect(fact).not.toHaveTextContent("more");
      fireEvent.click(fact);
      expect(card()).toBeNull();
      expect(row("a").querySelector("[data-pr-rollup]")).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector(".pr-rollup-popover")).not.toBeNull();
      expect(open).not.toHaveBeenCalled();
    });

    it("opens the lead PR where the row's density hides its rollup", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      renderSidebar({ threads: [thread("a", { prs: [pr(7), pr(8)] })] });
      fireEvent.click(within(hoverOpen("a")).getByRole("button", { name: /^Show 2 pull requests/, hidden: true }));
      expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/pull\/[78]$/), "_blank", "noopener,noreferrer");
    });
  });

  it("ignores a late application list after moving to a peer with no usable terminal", async () => {
    let resolveLab!: (result: { applications: DesktopApplicationsSnapshot }) => void;
    const lab = new Promise<{ applications: DesktopApplicationsSnapshot }>((resolve) => { resolveLab = resolve; });
    const readApplications = vi.fn()
      .mockReturnValueOnce(lab)
      .mockResolvedValueOnce({ applications: {
        ...APPLICATIONS,
        terminals: APPLICATIONS.terminals.map((terminal) => ({ ...terminal, canOpenWorkspace: false })),
      } });
    (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn(), readApplications, applicationWorkspaceExists: async () => true };
    renderSidebar({ applications: APPLICATIONS, threads: [peerThread("a"), peerThread("b", "build")] });
    const first = screen.getByText("Thread a");
    move(document.querySelector(".sidebar")!, first);
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    await act(async () => move(first, screen.getByText("Thread b")));
    await act(async () => resolveLab({ applications: APPLICATIONS }));
    expect(card()).toHaveTextContent("build-mini");
    expect(within(card()!).queryByRole("button", { name: /Open terminal|Open in/, hidden: true })).toBeNull();
    expect(readApplications.mock.calls).toEqual([
      [{ federationTarget: { scope: "remote", instanceId: "lab" } }],
      [{ federationTarget: { scope: "remote", instanceId: "build" } }],
    ]);
  });

  it("shares an in-flight discovery across a peer's cards and retries after failure", async () => {
    let rejectRead!: (error: Error) => void;
    const pending = new Promise((_, reject) => { rejectRead = reject; });
    const readApplications = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({
      applications: { ...APPLICATIONS, preferredTerminalId: { value: "uninstalled", source: "config" } },
    });
    const openApplication = vi.fn(async () => ({}));
    (window as { pwragent?: unknown }).pwragent = { readApplications, openApplication, applicationWorkspaceExists: async () => true };
    const peers = [peerThread("a"), peerThread("b")];
    const view = renderSidebar({ threads: peers });
    const first = screen.getByText("Thread a");
    const second = screen.getByText("Thread b");
    move(document.querySelector(".sidebar")!, first);
    act(() => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    move(first, second);
    expect(readApplications).toHaveBeenCalledTimes(1);
    await act(async () => rejectRead(new Error("Peer disconnected")));
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    view.rerender(sidebarElement({ threads: [{ ...peers[0]!, title: "Thread a updated" }, peers[1]!] }));
    expect(readApplications).toHaveBeenCalledTimes(1);
    await act(async () => move(second, screen.getByText("Thread a updated")));
    expect(readApplications).toHaveBeenCalledTimes(2);
    fireEvent.click(within(card()!).getByRole("button", { name: "Open terminal on lab-mini", hidden: true }));
    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "ghostty", kind: "terminal", targetPath: "/wt/mathathon",
      federationTarget: { scope: "remote", instanceId: "lab" },
    });
  });

  it("shares a pending folder check for the same peer and path, then checks again on the next visit", async () => {
    let confirm!: (exists: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { confirm = resolve; });
    const applicationWorkspaceExists = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(false);
    (window as { pwragent?: unknown }).pwragent = {
      openApplication: vi.fn(), readApplications: async () => ({ applications: APPLICATIONS }), applicationWorkspaceExists,
    };
    const otherFolder = peerThread("d");
    otherFolder.linkedDirectories = [{ ...otherFolder.linkedDirectories![0]!, worktreePath: "/wt/other" }];
    renderSidebar({ threads: [peerThread("a"), peerThread("b"), peerThread("c", "build"), otherFolder] });
    const a = screen.getByText("Thread a");
    const b = screen.getByText("Thread b");
    const c = screen.getByText("Thread c");
    const d = screen.getByText("Thread d");
    move(document.querySelector(".sidebar")!, a);
    await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    await act(async () => move(a, c));
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    await act(async () => move(c, d));
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    await act(async () => move(d, b));
    await act(async () => confirm(true));
    expect(within(card()!).getByRole("button", { name: "Open terminal on lab-mini", hidden: true })).toBeInTheDocument();
    const check = (instanceId: string, targetPath: string) => [{ federationTarget: { scope: "remote", instanceId }, targetPath }];
    expect(applicationWorkspaceExists.mock.calls).toEqual([
      check("lab", "/wt/mathathon"), check("build", "/wt/mathathon"), check("lab", "/wt/other"),
    ]);
    await act(async () => move(b, a));
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    expect(applicationWorkspaceExists).toHaveBeenCalledTimes(4);
  });

  it("requires the owner to confirm the projected row's primary folder still exists", async () => {
    const applicationWorkspaceExists = vi.fn(async () => false);
    (window as { pwragent?: unknown }).pwragent = {
      openApplication: vi.fn(), readApplications: vi.fn(async () => ({ applications: APPLICATIONS })), applicationWorkspaceExists,
    };
    renderSidebar({ threads: [projectedRow(peerThread("a"))] });
    move(document.querySelector(".sidebar")!, screen.getByText("Thread a"));
    await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(card()).toHaveTextContent("lab-mini");
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    expect(applicationWorkspaceExists.mock.calls).toEqual([[
      { federationTarget: { scope: "remote", instanceId: "lab" }, targetPath: "/wt/mathathon" },
    ]]);
  });

  it("removes the terminal from an open card when the owner revokes remote_window", async () => {
    const readApplications = vi.fn(async () => ({ applications: APPLICATIONS }));
    (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn(), readApplications, applicationWorkspaceExists: async () => true };
    const peer = peerThread("a");
    const view = renderSidebar({ threads: [peer] });
    move(document.querySelector(".sidebar")!, screen.getByText("Thread a"));
    await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
    expect(within(card()!).getByRole("button", { name: "Open terminal on lab-mini", hidden: true })).toBeInTheDocument();
    view.rerender(sidebarElement({ threads: [{
      ...peer, federation: { ...peer.federation!, capabilities: [] },
    }] }));
    expect(card()).toHaveTextContent("lab-mini");
    expect(within(card()!).queryByRole("button", { name: /Open terminal/, hidden: true })).toBeNull();
    expect(readApplications).toHaveBeenCalledTimes(1);
  });

  it.each(["disconnected", "no grant", "hibernated checkout", "no folder"] as const)(
    "skips peer application discovery for a thread with %s",
    async (reason) => {
      const readApplications = vi.fn(async () => ({ applications: APPLICATIONS }));
      (window as { pwragent?: unknown }).pwragent = { openApplication: vi.fn(), readApplications, applicationWorkspaceExists: async () => true };
      const peer = peerThread("a");
      if (reason === "disconnected") peer.federation!.peerStatus = "disconnected";
      if (reason === "no grant") peer.federation!.capabilities = ["turn_control"];
      if (reason === "hibernated checkout") peer.checkoutHibernated = true;
      if (reason === "no folder") peer.linkedDirectories = [];
      renderSidebar({ applications: APPLICATIONS, threads: [projectedRow(peer)] });
      move(document.querySelector(".sidebar")!, screen.getByText("Thread a"));
      await act(async () => vi.advanceTimersByTime(PROJECT_CARD_HOVER_DELAY_MS));
      expect(card()).toHaveTextContent("lab-mini");
      expect(within(card()!).queryByRole("button", { name: /Open terminal|Open in/, hidden: true })).toBeNull();
      expect(readApplications).not.toHaveBeenCalled();
    },
  );
});
