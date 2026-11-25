import { useCallback, useMemo } from "react";
import { act, fireEvent, render, within } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { App } from "../App";
import { HistoryNavButtons } from "../features/chrome/HistoryNavButtons";
import { Sidebar } from "../features/navigation/Sidebar";
import { TranscriptList } from "../features/thread-detail/TranscriptList";
import type { DesktopApi } from "../lib/desktop-api";
import { threadSummaryIdentityKey } from "../lib/federated-thread-events";
import { navigationIdentityFromThreadKey } from "../lib/navigation-query-state";
import {
  useNavigationHistory,
  type NavigationHistoryLocation,
} from "../lib/useNavigationHistory";
import { useThreadNavigation } from "../lib/useThreadNavigation";
import { useThreadSessionState } from "../lib/useThreadSessionState";
import { navigationOwnerApiFixture } from "../test/navigation-owner-api-fixture";

// Warm the real transcript tree during collection, as in app-shell.test.tsx.
await import("../features/thread-detail/ThreadView");

const threads: NavigationThreadSummary[] = [
  {
    id: "first",
    source: "codex",
    title: "First fixture thread",
    titleSource: "explicit",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: 2,
  },
  {
    id: "second",
    source: "acp:antigravity",
    title: "Second fixture thread",
    titleSource: "explicit",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: 1,
  },
];

type NavigationAction = "open" | "back" | "forward" | "context menu" | "toggle batch";

const EMPTY_BACKENDS: never[] = [];
const NOOP_ASYNC = async (): Promise<void> => undefined;
const transcriptText = (id: string) => `Transcript for fixture ${id}`;

function createFixtureApi(): DesktopApi {
  return navigationOwnerApiFixture({
    readPopulation: async () => ({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: threads.map(({ source, id }) => `${source}:${id}`),
      threads,
      directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" },
    }),
    readThread: async ({ backend = "codex", threadId }) => ({
      backend,
      threadId,
      fetchedAt: 1,
      replay: {
        entries: [{
          type: "message",
          id: `message-${threadId}`,
          role: "assistant",
          text: transcriptText(threadId),
        }],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }),
  });
}

// Composes the real navigation, history, session, sidebar, and transcript layers
// without the rest of DesktopAppShell (Composer/Tiptap, context rail, notices),
// keeping the multi-run property model well under the 5 s Linux/macOS timeout.
function ActiveThreadHarness(props: { desktopApi: DesktopApi }) {
  const navigation = useThreadNavigation(props.desktopApi);
  const historyLocation = useMemo<NavigationHistoryLocation | undefined>(() => {
    if (!navigation.selectedThreadKey) return undefined;
    const selected = navigation.selectedThread;
    const label = selected
      && threadSummaryIdentityKey(selected) === navigation.selectedThreadKey
      ? selected.title
      : undefined;
    return {
      view: "thread",
      threadKey: navigation.selectedThreadKey,
      ...(label ? { label } : {}),
    };
  }, [navigation.selectedThread, navigation.selectedThreadKey]);

  const restoreHistoryLocation = useCallback((location: NavigationHistoryLocation): void => {
    if (location.view !== "thread") return;
    const ref = navigationIdentityFromThreadKey(location.threadKey);
    if (!ref) return;
    void navigation.showThread({
      backend: ref.backend,
      threadId: ref.threadId,
      federationTarget: ref.ownerInstanceId
        ? { scope: "remote", instanceId: ref.ownerInstanceId }
        : undefined,
    });
  }, [navigation]);

  const history = useNavigationHistory({
    current: historyLocation,
    restore: restoreHistoryLocation,
    archivedThreadKeys: navigation.archivedThreadKeys,
  });

  const session = useThreadSessionState({
    desktopApi: props.desktopApi,
    thread: navigation.selectedThread,
  });

  return (
    <>
      <Sidebar
        backends={EMPTY_BACKENDS}
        browseMode={navigation.browseMode}
        directories={navigation.directories}
        directoryDisclosure={navigation.directoryDisclosure}
        inboxThreads={navigation.inboxThreads}
        loaded={navigation.loaded}
        loading={navigation.loading}
        pagedNavigation={navigation.pagedNavigation}
        recentThreads={navigation.recentThreads}
        selectedItemKey={navigation.selectedItemKey}
        selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys}
        threads={navigation.threads}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={NOOP_ASYNC}
        onOpenLaunchpad={NOOP_ASYNC}
        onSelectThread={navigation.selectThread}
      />
      <main>
        <HistoryNavButtons
          backLabel={history.backLabel}
          canGoBack={history.canGoBack}
          canGoForward={history.canGoForward}
          forwardLabel={history.forwardLabel}
          onBack={history.goBack}
          onForward={history.goForward}
        />
        <TranscriptList
          entries={session.entries}
          loading={session.loading}
          loadingMore={session.loadingMore}
          threadId={navigation.selectedThreadKey}
          onLoadOlder={session.loadOlder}
        />
      </main>
    </>
  );
}

function createViewHelpers(view: ReturnType<typeof render>) {
  const mainElement = view.getByRole("main");
  const main = within(mainElement);
  const sidebar = view.getByRole("complementary", { name: "Threads" });

  const row = (index: number): HTMLButtonElement => {
    const { id, source } = threads[index]!;
    const button = sidebar.querySelector<HTMLButtonElement>(
      `[data-thread-key="${source}:${id}"] > .thread-row > .thread-row__open`,
    );
    expect(button).not.toBeNull();
    return button!;
  };

  const checkSelection = async (index: number): Promise<void> => {
    const { id, source } = threads[index]!;
    const activeKeys = [...sidebar.querySelectorAll("[data-thread-key] > .thread-row.is-selected")]
      .map((card) => card.parentElement?.dataset.threadKey);
    expect(activeKeys).toEqual([`${source}:${id}`]);
    expect([...sidebar.querySelectorAll(".thread-row__open[aria-current='true']")]).toEqual([row(index)]);

    const expectedText = transcriptText(id);
    const otherText = transcriptText(threads[1 - index]!.id);
    if (!mainElement.querySelector(".transcript-list")?.textContent?.includes(expectedText)) {
      await main.findByText(expectedText);
    }
    const transcript = mainElement.querySelector(".transcript-list")?.textContent ?? "";
    expect(transcript).toContain(expectedText);
    expect(transcript).not.toContain(otherText);
  };

  const waitForInitialLoad = async (): Promise<void> => {
    await main.findByText(transcriptText(threads[0]!.id));
    for (const [index, thread] of threads.entries()) {
      expect(within(sidebar).getByRole("button", { name: thread.title })).toBe(row(index));
    }
    await checkSelection(0);
  };

  return { row, checkSelection, waitForInitialLoad };
}

async function runAction(
  view: ReturnType<typeof render>,
  helpers: ReturnType<typeof createViewHelpers>,
  state: { visits: number[]; cursor: number; batchDirty: boolean },
  command: NavigationAction,
): Promise<void> {
  const other = 1 - state.visits[state.cursor]!;
  await act(async () => {
    switch (command) {
      case "open":
        fireEvent.click(helpers.row(other));
        state.visits.splice(state.cursor + 1);
        if (state.visits.at(-1) !== other) state.visits.push(other);
        state.cursor = state.visits.length - 1;
        state.batchDirty = false;
        break;
      case "back":
        if (state.cursor > 0) {
          fireEvent.click(view.getByTestId("history-nav-back"));
          state.cursor -= 1;
          state.batchDirty = false;
        }
        break;
      case "forward":
        fireEvent.click(view.getByTestId("history-nav-forward"));
        if (state.cursor < state.visits.length - 1) {
          state.cursor += 1;
          state.batchDirty = false;
        }
        break;
      case "context menu":
        fireEvent.contextMenu(helpers.row(other));
        state.batchDirty = true;
        break;
      case "toggle batch":
        fireEvent.click(helpers.row(other), { metaKey: true });
        state.batchDirty = true;
        break;
    }
  });
  if (command === "context menu") {
    const menu = document.querySelector<HTMLElement>("[role='menu']");
    expect(menu).not.toBeNull();
    try {
      await helpers.checkSelection(state.visits[state.cursor]!);
    } finally {
      fireEvent.keyDown(menu!, { key: "Escape" });
    }
  }
  await helpers.checkSelection(state.visits[state.cursor]!);
  expect(view.getByTestId("history-nav-forward").hasAttribute("disabled"))
    .toBe(state.cursor === state.visits.length - 1);
}

it("keeps the active row and transcript on the same thread through navigation and row actions", async ({ signal }) => {
  const action = fc.constantFrom<NavigationAction>(
    "open",
    "back",
    "forward",
    "context menu",
    "toggle batch",
  );
  const view = render(<ActiveThreadHarness desktopApi={createFixtureApi()} />);
  try {
    const helpers = createViewHelpers(view);
    await helpers.waitForInitialLoad();

    // Reuse the mounted harness across runs while guaranteeing each case starts
    // at history suffix [..., 1, 0] (cursor at tip 0, batch state cleared).
    // Falling back to a full [1, 0] reset after any failure keeps shrinking
    // independent of older visits.
    let live = { visits: [0], cursor: 0, batchDirty: false, synchronized: true };
    const ensureCaseStart = async (): Promise<void> => {
      const atTipZero = live.synchronized
        && live.cursor === live.visits.length - 1
        && live.visits[live.cursor] === 0
        && live.cursor > 0
        && live.visits[live.cursor - 1] === 1;
      if (atTipZero) {
        if (live.batchDirty) {
          await act(async () => { fireEvent.click(helpers.row(0)); });
          await helpers.checkSelection(0);
        }
      } else if (live.synchronized && live.visits[live.cursor] === 1) {
        await act(async () => { fireEvent.click(helpers.row(0)); });
        await helpers.checkSelection(0);
      } else {
        for (const index of [1, 0]) {
          await act(async () => { fireEvent.click(helpers.row(index)); });
          await helpers.checkSelection(index);
        }
      }
      live = { visits: [1, 0], cursor: 1, batchDirty: false, synchronized: false };
    };

    await fc.assert(fc.asyncProperty(
      fc.array(action, { minLength: 1, maxLength: 7 }),
      async (actions) => {
        signal.throwIfAborted();
        await ensureCaseStart();
        const state = { visits: [1, 0], cursor: 1, batchDirty: false };
        for (const command of actions) {
          signal.throwIfAborted();
          await runAction(view, helpers, state, command);
        }
        live = { ...state, synchronized: true };
      },
    ), { numRuns: 25 });
  } finally {
    view.unmount();
  }
});

it("wires the full App shell so active row and transcript stay aligned through navigation and row actions", async () => {
  const previous = Object.getOwnPropertyDescriptor(window, "pwragent");
  Object.defineProperty(window, "pwragent", { configurable: true, value: createFixtureApi() });
  const app = render(<App />);
  try {
    const helpers = createViewHelpers(app);
    await helpers.waitForInitialLoad();

    const state = { visits: [0], cursor: 0, batchDirty: false };
    const actions: NavigationAction[] = [
      "context menu",
      "toggle batch",
      "open",
      "context menu",
      "toggle batch",
      "back",
      "forward",
      "back",
      "open",
      "forward",
    ];
    for (const command of actions) {
      await runAction(app, helpers, state, command);
    }
  } finally {
    app.unmount();
    if (previous) Object.defineProperty(window, "pwragent", previous);
    else Reflect.deleteProperty(window, "pwragent");
  }
});
