import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import {
  KEEP_AT_TOP_RANK_BOUNDARY,
  type BackendSummary,
  type NavigationQueryPage,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { RecentsList, readPinnedGroupCounts } from "../RecentsList";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

const backends: BackendSummary[] = [{
  kind: "codex",
  label: "Codex app server",
  available: true,
  methods: ["thread/start"],
  capabilities: {
    listThreads: true, createThread: true, resumeThread: true, archiveThread: true,
    restoreThread: true, renameThread: true, readThread: true, startTurn: true,
    interruptTurn: true, steerTurn: true, transcriptPagination: true, toolUse: false,
    approvalRequests: false, multiDirectoryThreads: true,
  },
  executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
}];

const thread = (
  id: string,
  title: string,
  createdAt: number,
  extra: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary => ({
  id,
  title,
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  createdAt,
  updatedAt: createdAt,
  inbox: { inInbox: false },
  linkedDirectories: [],
  ...extra,
});

const KEPT_RANK = String(KEEP_AT_TOP_RANK_BOUNDARY * 2);

// Newest first, the order the creation-time list renders in.
const releaseManager = thread("release", "Release manager", 6, { pinnedRank: KEPT_RANK });
const rateLimiter = thread("rate", "Rate limiter rewrite", 5, { pinnedRank: "2048" });
const chartTokens = thread("chart", "Dark-mode chart tokens", 4);
const docsMigration = thread("docs", "Docs IA migration", 3, { pinnedRank: "1024" });
const glossary = thread("glossary", "Glossary search index", 2);
const flakyFixture = thread("flaky", "Flaky auth fixture", 1);
const population = [releaseManager, rateLimiter, chartTokens, docsMigration, glossary, flakyFixture];

afterEach(() => cleanup());

function renderRecents(props: Partial<ComponentProps<typeof Sidebar>> = {}) {
  const view = render(
    <Sidebar
      backends={backends}
      browseMode="recents"
      directories={[]}
      loading={false}
      threads={population}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectThread={() => undefined}
      {...props}
    />,
  );
  return view;
}

function pinnedGroup(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".pinned-group");
}

function groupHeader(): HTMLElement {
  return screen.getByRole("button", { name: /^Pinned,/ });
}

function titlesIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".thread-row-shell .thread-row__title")]
    .map((element) => element.textContent ?? "");
}

function listTitles(): string[] {
  const list = [...document.querySelectorAll<HTMLElement>(".sidebar-list--compact[role='list']")]
    .find((element) => !element.closest(".pinned-group"));
  return list ? titlesIn(list) : [];
}

describe("Pinned group", () => {
  it("renders every pin once, in the group, in the one global pin order", () => {
    renderRecents();

    // Kept pins lead, then ordinary pins by rank: not creation order.
    expect(titlesIn(pinnedGroup()!)).toEqual([
      "Release manager",
      "Docs IA migration",
      "Rate limiter rewrite",
    ]);
    // The list keeps creation order and holds no pin.
    expect(listTitles()).toEqual([
      "Dark-mode chart tokens",
      "Glossary search index",
      "Flaky auth fixture",
    ]);
    for (const title of population.map((entry) => entry.title)) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${title}`) })).toHaveLength(1);
    }
    expect(groupHeader()).toHaveAccessibleName("Pinned, 3 threads");
    expect(groupHeader()).toHaveAttribute("aria-expanded", "true");
  });

  it("returns an unpinned thread to its creation-time slot without moving its neighbours", () => {
    const view = renderRecents();
    view.rerender(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={[]}
        loading={false}
        threads={population.map((entry) => entry === rateLimiter ? { ...entry, pinnedRank: undefined } : entry)}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(titlesIn(pinnedGroup()!)).toEqual(["Release manager", "Docs IA migration"]);
    expect(listTitles()).toEqual([
      "Rate limiter rewrite",
      "Dark-mode chart tokens",
      "Glossary search index",
      "Flaky auth fixture",
    ]);
  });

  it.each(["recents", "inbox"] as const)("draws no group in %s without pins", (browseMode) => {
    renderRecents({ browseMode, threads: population.map((entry) => ({ ...entry, pinnedRank: undefined })) });
    expect(pinnedGroup()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pinned,/ })).not.toBeInTheDocument();
    expect(listTitles()).toEqual(population.map((entry) => entry.title));
  });

  it("gathers Updated's pins the same way, above its last-update list", () => {
    // The owner orders Updated by last update; pins leave that order for the group.
    const byUpdate = [glossary, rateLimiter, flakyFixture, releaseManager, chartTokens, docsMigration];
    renderRecents({ browseMode: "inbox", threads: byUpdate,
      onReorderThreadPins: async () => undefined, onSetThreadPin: async () => undefined });

    expect(titlesIn(pinnedGroup()!)).toEqual([
      "Release manager",
      "Docs IA migration",
      "Rate limiter rewrite",
    ]);
    expect(listTitles()).toEqual([
      "Glossary search index",
      "Flaky auth fixture",
      "Dark-mode chart tokens",
    ]);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Docs IA migration/ }));
    expect(screen.getByRole("menuitem", { name: /Move Up/ })).toBeInTheDocument();
  });

  it.each(["recents", "inbox"] as const)("keeps %s a pure time sort with pinned threads in place", (browseMode) => {
    renderRecents({ browseMode, pinnedThreadsOnTop: false,
      onReorderThreadPins: async () => undefined, onSetThreadPin: async () => undefined });

    expect(pinnedGroup()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pinned,/ })).not.toBeInTheDocument();
    expect(listTitles()).toEqual(population.map((entry) => entry.title));
    // No visible pin order, so no pin-order controls either.
    const docs = screen.getByRole("button", { name: /^Docs IA migration/ });
    expect(docs.closest(".thread-row-shell")).not.toHaveClass("is-draggable");
    fireEvent.contextMenu(docs);
    expect(screen.queryByRole("menuitem", { name: /Move Up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Keep at Top" })).not.toBeInTheDocument();
  });

  it("toggles from its header and renders closed from the saved state", () => {
    const onSetPinnedGroupCollapsed = vi.fn();
    const view = renderRecents({ onSetPinnedGroupCollapsed });

    fireEvent.click(groupHeader());
    expect(onSetPinnedGroupCollapsed).toHaveBeenCalledWith(true);

    view.rerender(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={[]}
        loading={false}
        pinnedGroupCollapsed
        threads={population}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetPinnedGroupCollapsed={onSetPinnedGroupCollapsed}
      />,
    );
    expect(groupHeader()).toHaveAttribute("aria-expanded", "false");
    expect(titlesIn(pinnedGroup()!)).toEqual([]);
    expect(listTitles()).toEqual([
      "Dark-mode chart tokens",
      "Glossary search index",
      "Flaky auth fixture",
    ]);

    fireEvent.click(groupHeader());
    expect(onSetPinnedGroupCollapsed).toHaveBeenLastCalledWith(false);
  });

  it("keeps both rollups on the collapsed header, grey at zero", () => {
    renderRecents({ pinnedGroupCollapsed: true });
    const header = groupHeader();

    const active = header.querySelector("[data-attention-active-count]");
    const review = header.querySelector("[data-attention-review-count]");
    expect(active).toHaveAttribute("data-attention-active-count", "0");
    expect(active).toHaveAttribute("data-zero", "true");
    expect(review).toHaveAttribute("data-attention-review-count", "0");
    expect(review).toHaveAttribute("data-zero", "true");
    expect(header).toHaveAccessibleName("Pinned, 3 threads, 0 active threads, 0 unread");
  });

  it("counts running and unread work inside the collapsed group only", () => {
    renderRecents({
      pinnedGroupCollapsed: true,
      threads: population.map((entry) =>
        entry === rateLimiter ? { ...entry, threadStatus: "active" as const }
        : entry === docsMigration ? { ...entry, inbox: { inInbox: true, reason: "updated-since-seen" as const } }
        // Work outside the group never reaches its header.
        : entry === chartTokens ? { ...entry, threadStatus: "active" as const, inbox: { inInbox: true, reason: "new-thread" as const } }
        : entry),
    });
    const header = groupHeader();

    expect(header.querySelector("[data-attention-active-count]")).toHaveAttribute("data-attention-active-count", "1");
    expect(header.querySelector("[data-attention-active-count]")).not.toHaveAttribute("data-zero");
    expect(header.querySelector("[data-attention-review-count]")).toHaveAttribute("data-attention-review-count", "1");
    expect(header).toHaveAccessibleName("Pinned, 3 threads, 1 active thread, 1 unread");
  });

  it("opens a closed group to reveal a pinned selection, and only then", () => {
    const onSetPinnedGroupCollapsed = vi.fn();
    const view = renderRecents({
      pinnedGroupCollapsed: true,
      selectedItemKey: "codex:glossary",
      revealSelectedThreadRequest: 1,
      onSetPinnedGroupCollapsed,
    });
    expect(onSetPinnedGroupCollapsed).not.toHaveBeenCalled();

    view.rerender(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={[]}
        loading={false}
        pinnedGroupCollapsed
        revealSelectedThreadRequest={2}
        selectedItemKey="codex:docs"
        threads={population}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetPinnedGroupCollapsed={onSetPinnedGroupCollapsed}
      />,
    );
    expect(onSetPinnedGroupCollapsed).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("opens a closed group when a list row is pinned, so selection follows it", async () => {
    const onSetPinnedGroupCollapsed = vi.fn();
    const onSetThreadPin = vi.fn(async () => undefined);
    renderRecents({ pinnedGroupCollapsed: true, onSetPinnedGroupCollapsed, onSetThreadPin });

    const row = screen.getByRole("button", { name: /^Glossary search index/ });
    fireEvent.click(row.closest(".thread-row-shell")!.querySelector(".thread-row__overflow-button")!);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    });

    expect(onSetThreadPin).toHaveBeenCalledWith(expect.objectContaining({ id: "glossary" }), true);
    expect(onSetPinnedGroupCollapsed).toHaveBeenCalledWith(false);
  });

  it("orders the group with Directories' controls, and the list gets none", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);
    renderRecents({ onReorderThreadPins, onSetThreadPin: async () => undefined });
    const group = pinnedGroup()!;

    // The Keep at top slot sits above the first ordinary pin.
    // Directories' own slot, hidden until a drag opens it.
    const slot = group.querySelector(".directory-row__keep-top-slot")!;
    expect(slot).toHaveAttribute("aria-label", "Keep thread at top of pinned threads");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    const docsShell = within(group).getByRole("button", { name: /^Docs IA migration/ }).closest(".thread-row-shell")!;
    expect(slot.parentElement?.nextElementSibling?.contains(docsShell)).toBe(true);
    expect(docsShell).toHaveClass("is-draggable");
    expect(docsShell).toHaveAttribute("data-thread-pin-state", "pinned");

    fireEvent.keyDown(within(group).getByRole("button", { name: /^Docs IA migration/ }), {
      key: "ArrowUp", metaKey: true, shiftKey: true,
    });
    expect(onReorderThreadPins).toHaveBeenCalledWith([], { key: "codex:docs", direction: "up" });

    fireEvent.contextMenu(within(group).getByRole("button", { name: /^Docs IA migration/ }), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menuitem", { name: /Move Up/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Move Down/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Keep at Top" })).toHaveAttribute("aria-checked", "false");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Keep at Top" }));
    });
    expect(onReorderThreadPins).toHaveBeenLastCalledWith([], { key: "codex:docs", keepAtTop: true });
    // A check item toggles in place.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    const listShell = screen.getByRole("button", { name: /^Glossary search index/ }).closest(".thread-row-shell")!;
    expect(listShell).not.toHaveClass("is-draggable");
    expect(listShell).not.toHaveAttribute("data-thread-pin-state");
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Glossary search index/ }), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menuitem", { name: /Move Up/ })).not.toBeInTheDocument();
  });
});

describe("Pinned group against an owner without the split", () => {
  const resource = (id: string, query: NavigationWindowResource["state"]["request"]["query"], pageSize: number): NavigationWindowResource => {
    const request = { protocol: 2 as const, consumer: "main-sidebar" as const, query, pageSize };
    // An older owner ignores `roots`: both pages carry every thread, by
    // creation, and neither carries a collection size.
    const page = navigationQueryFixture({ ...request, query: { kind: "lens", lens: "recents" } }, { threads: population });
    return { id, loading: false, state: { ...createNavigationPageState(request), page, stale: false } };
  };

  it("still renders each thread once, filtering each page by its roots' own pins", () => {
    const resources = new Map([
      ["lens-pins", resource("lens-pins", { kind: "lens", lens: "recents", roots: "pinned" }, 100)],
      ["lens", resource("lens", { kind: "lens", lens: "recents", roots: "unpinned" }, 100)],
    ]);
    render(
      <RecentsList
        pagedNavigation={{ resources } as unknown as ComponentProps<typeof RecentsList>["pagedNavigation"]}
        pinnedResourceId="lens-pins"
        resourceIds={["lens"]}
        threads={population}
        onOpenThreadContextMenu={() => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(titlesIn(pinnedGroup()!)).toEqual([
      "Release manager",
      "Docs IA migration",
      "Rate limiter rewrite",
    ]);
    expect(listTitles()).toEqual([
      "Dark-mode chart tokens",
      "Glossary search index",
      "Flaky auth fixture",
    ]);
  });

  it("keeps every pin in the list until the group's own page is demanded", () => {
    // The render where the setting turns on: the list's page is in hand and
    // the group's is not yet demanded. No pin may vanish from both.
    const resources = new Map([
      ["lens", resource("lens", { kind: "lens", lens: "recents" }, 100)],
    ]);
    render(
      <RecentsList
        pagedNavigation={{ resources } as unknown as ComponentProps<typeof RecentsList>["pagedNavigation"]}
        pinnedResourceId="lens-pins"
        resourceIds={["lens"]}
        threads={population}
        onOpenThreadContextMenu={() => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(pinnedGroup()).toBeNull();
    expect(listTitles()).toEqual(population.map((entry) => entry.title));
  });

  it("counts the header from the loaded pins when the owner sent no split", () => {
    const page = { counts: { total: 6, active: 4, unread: 4, review: 4 } } as unknown as NavigationQueryPage;
    const roots = [{ ...rateLimiter, threadStatus: "active" as const }, docsMigration];
    const child = thread("child", "Child of docs", 0, {
      parentThreadId: "docs",
      inbox: { inInbox: true, reason: "updated-since-seen" },
    });
    expect(readPinnedGroupCounts({
      page,
      roots,
      subtree: (root) => root.id === "docs" ? [child] : [],
    })).toEqual({ total: 2, activeLocal: 1, review: 1 });
    // An owner that split the lens counted its whole bucket.
    expect(readPinnedGroupCounts({
      page: { ...page, collectionSize: 7 },
      roots,
      subtree: () => [],
    })).toEqual({ total: 7, activeLocal: 4, review: 4 });
  });
});
