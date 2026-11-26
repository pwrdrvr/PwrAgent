import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, StartReviewRequest, StartReviewResponse } from "@pwragent/shared/contracts/agent";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadReviewEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { threadTodoThreadKey, type ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { useThreadSessionState } from "../../../lib/useThreadSessionState";
import { ThreadView, type ThreadViewProps } from "../../thread-detail/ThreadView";
import type { ThreadTodosView } from "../../thread-todos/thread-todos-view";
import { Composer, type ComposerProps } from "../Composer";
import {
  buildThreadComposerScopeKey,
  useComposerDraftStore,
  type ComposerDraftStore,
} from "../useComposerDraftStore";

afterEach(cleanup);

const codexBackend: BackendSummary = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  methods: ["thread/start", "turn/start", "review/start"],
  capabilities: {
    listThreads: true,
    createThread: true,
    forkThread: true,
    resumeThread: true,
    archiveThread: true,
    restoreThread: true,
    archiveWorktree: true,
    restoreWorktree: true,
    renameThread: true,
    readThread: true,
    startTurn: true,
    startReview: true,
    reviewRunMode: true,
    reviewAutoFix: true,
    reviewPullRequestSet: true,
    reviewCodexSubAgent: true,
    reviewRunner: true,
    interruptTurn: true,
    steerTurn: true,
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: true,
  },
  executionModes: [
    { mode: "default", label: "Default Access", available: true, isDefault: true },
    { mode: "auto", label: "Auto", available: true },
    { mode: "full-access", label: "Full Access", available: true },
  ],
};

function makeThread(id: string, overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: `Thread ${id}`,
    titleSource: "explicit",
    gitBranch: "feature/review-test",
    linkedDirectories: [{
      id: "/repo/project",
      kind: "worktree",
      label: "project",
      path: "/repo/project",
      worktreePath: "/repo/project",
      gitBranch: "feature/review-test",
    }],
    inbox: { inInbox: false },
    ...overrides,
  };
}

type EntryKind = "type-review" | "slash-menu" | "review-request";
type OutcomeKind = "start-immediate" | "queue-busy" | "cancel" | "switch-away";

function makeReviewTodo(thread: NavigationThreadSummary): ThreadTodo {
  return {
    id: `todo:review:${thread.id}`,
    backend: thread.source,
    threadId: thread.id,
    title: "Review changes",
    kind: "review",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    action: { type: "start_review" },
  };
}

function makeTodosView(todo: ThreadTodo, resolve: ThreadTodosView["resolve"]): ThreadTodosView {
  return {
    open: [todo],
    openByThreadKey: new Map([[threadTodoThreadKey(todo), [todo]]]),
    revision: 0,
    runningIds: new Set(),
    instances: [],
    threadTitle: () => "Thread A",
    resolve,
    run: vi.fn(),
    setItemChecked: vi.fn(),
    openThread: vi.fn(),
    openStartedThread: vi.fn(),
    waits: [],
    waitsByThreadKey: new Map(),
    seenKeys: new Set(),
    markSeen: vi.fn(),
    respond: vi.fn(),
    dismissQuestion: vi.fn(),
    dismissedQuestionKeys: new Set(),
    openWait: vi.fn(),
    threadTitleForKey: () => "Thread A",
    threadProjectForKey: () => undefined,
  };
}

async function openReviewPanel(): Promise<void> {
  const input = screen.getByLabelText("Reply");
  fireEvent.change(input, { target: { value: "/review" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
}

it.each(["before", "after"] as const)(
  "reconciles repeated mounted Antigravity reviews when the owner header arrives %s the start response",
  async (arrivalOrder) => {
    const backend = "acp:antigravity";
    const pullRequest = {
      provider: "github.com" as const, org: "fixture", repo: "project", number: 4408,
      url: "https://github.com/fixture/project/pull/4408",
    };
    const thread = makeThread("managed-review-thread", {
      source: backend,
      prs: [{
        ...pullRequest, title: "Sample change", state: "passing",
        lifecycleState: "open", headRefName: "feature/review-test", baseRefName: "main",
        linkedDirectoryPaths: ["/repo/project"],
      }],
    });
    const context = {
      workspacePath: "/repo/project",
      gitBranch: "feature/review-test",
      headCommit: "949b0964f7",
      pullRequest,
    };
    const optimisticLabel = `Review ${pullRequest.url}`;
    const canonicalLabel = `${optimisticLabel} at ${context.headCommit}`;
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    };
    const ownerEntries: AppServerThreadReviewEntry[] = [];
    const startReview = vi.fn<(request: StartReviewRequest) => Promise<StartReviewResponse>>();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      startReview,
      readThread: async () => ({
        backend, threadId: thread.id, fetchedAt: Date.now(),
        replay: {
          entries: [...ownerEntries],
          messages: [],
          pagination: { supportsPagination: true, hasPreviousPage: false },
        },
      }),
    };
    let session!: ReturnType<typeof useThreadSessionState>;
    function Harness() {
      session = useThreadSessionState({ desktopApi, thread });
      const store = useComposerDraftStore();
      const terminals = useIntegratedTerminals(desktopApi);
      return (
        <ThreadView
          activeTurnId={session.activeTurnId}
          addOptimisticReviewEntry={session.addOptimisticReviewEntry}
          addOptimisticUserMessage={session.addOptimisticUserMessage}
          backends={[{
            ...codexBackend, kind: backend, label: "Antigravity",
            capabilities: { ...codexBackend.capabilities, reviewCodexSubAgent: false },
          }]}
          beginReviewSubmission={session.beginReviewSubmission}
          bindOptimisticReviewEntryToTurn={session.bindOptimisticReviewEntryToTurn}
          clearPendingRequest={session.clearPendingRequest}
          composerDisabled={false}
          composerDraftStore={store}
          desktopApi={desktopApi}
          loading={session.loading}
          loadingMore={session.loadingMore}
          messageCount={session.entries.length}
          onActiveTurnIdChange={session.setActiveTurnId}
          onLoadOlder={session.loadOlder}
          onPendingStatusChange={session.setPendingStatusText}
          removeOptimisticMessage={session.removeOptimisticMessage}
          selectedThread={thread}
          skills={[]}
          terminals={terminals}
          transcriptEntries={session.entries}
        />
      );
    }

    await act(async () => { render(<Harness />); });
    const readHeaders = () => session.entries
      .filter((entry): entry is AppServerThreadReviewEntry =>
        entry.type === "review" && Boolean(entry.displayText))
      .map(({ id, displayText, reviewer, context, turn }) => ({
        id, displayText, reviewer, context, turnId: turn?.id,
      }));
    const headers: ReturnType<typeof readHeaders> = [];

    for (const attempt of [1, 2]) {
      const turnId = `managed-review-${attempt}`;
      const id = `managed-review:${turnId}:started`;
      const reviewer = { backend, model: `fixture-reviewer-${attempt}` } as const;
      const receipt = Promise.withResolvers<StartReviewResponse>();
      startReview.mockReturnValueOnce(receipt.promise);
      await openReviewPanel();
      fireEvent.click(screen.getByRole("button", { name: /Attached PR/ }));
      const pr = screen.getByRole<HTMLInputElement>("radio", { name: /#4408/ });
      if (!pr.checked) fireEvent.click(pr);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start review" })); });
      expect(startReview).toHaveBeenCalledTimes(attempt);
      expect(startReview).toHaveBeenLastCalledWith(expect.objectContaining({
        backend, runMode: "pwragent-sub-agent", target: { type: "pullRequest", url: pullRequest.url },
      }));
      expect(readHeaders().map((header) => header.displayText)).toEqual([
        ...headers.map((header) => header.displayText), optimisticLabel,
      ]);

      const acknowledge = async () => {
        await act(async () => receipt.resolve({ backend, threadId: thread.id, reviewThreadId: thread.id, turnId }));
      };
      const publishStart = () => {
        const startedAt = Date.now();
        ownerEntries.push({
          type: "review", id, review: canonicalLabel, displayText: canonicalLabel,
          reviewer, context, createdAt: startedAt, turn: { id: turnId, status: "in_progress", startedAt },
        });
        act(() => {
          emit({ backend, notification: { method: "turn/started", params: {
            threadId: thread.id, turnId, turn: { id: turnId, status: "inProgress", startedAt },
          } } });
          emit({ backend, notification: { method: "item/completed", params: {
            threadId: thread.id, turnId,
            item: { type: "enteredReviewMode", id, review: canonicalLabel, createdAt: startedAt, data: { reviewer, context } },
          } } });
        });
      };
      if (arrivalOrder === "before") publishStart();
      await acknowledge();
      const headerBeforeLateEvent = readHeaders().at(-1);
      if (arrivalOrder === "after") publishStart();

      // The owner's turn IDs define the starts, even when two reviews use the
      // same PR and commit. Each header should use that turn's provenance.
      headers.push({ id, displayText: canonicalLabel, reviewer, context, turnId });
      expect(readHeaders()).toEqual(headers);
      if (arrivalOrder === "after") {
        expect(headerBeforeLateEvent).toMatchObject({ displayText: optimisticLabel, turnId });
      }

      const completedAt = Date.now();
      const turn = { id: turnId, status: "completed" as const, completedAt };
      ownerEntries[ownerEntries.length - 1] = { ...ownerEntries.at(-1)!, turn };
      await act(async () => {
        emit({ backend, notification: { method: "turn/completed", params: {
          threadId: thread.id, turnId, turn: { ...turn, output: [] },
        } } });
      });
    }
    await act(async () => { await session.reload(); });
    expect(readHeaders()).toEqual(headers);
  },
);

describe("review composer lifecycle invariants", () => {
  it.for([
    ["review-request", "queue-busy", false],
    ["review-request", "start-immediate", true],
    ["type-review", "queue-busy", true],
    ["slash-menu", "cancel", false],
    ["type-review", "switch-away", true],
  ] satisfies Array<[EntryKind, OutcomeKind, boolean]>)(
    "clears review setup after %s, %s, remount=%s",
    async ([entry, outcome, remountOnReturn]) => {
      cleanup();
      const threadA = makeThread("thread-a");
      const threadB = makeThread("thread-b");
      const scopeA = buildThreadComposerScopeKey(threadA.source, threadA.id, { scope: "local" });
      const startReview = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: threadA.id,
        reviewThreadId: threadA.id,
        turnId: "review-turn-1",
      }));
      const createScheduledThreadAction = vi.fn(async () => ({
        action: {
          id: "sched-review-1",
          backend: "codex" as const,
          threadId: threadA.id,
          kind: "review" as const,
          origin: "desktop" as const,
          status: "queued" as const,
          queueEntryId: "queue-review-1",
          scheduledFor: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          displayText: "Review current changes",
        },
      }));
      const desktopApi: DesktopApi = {
        onAgentEvent: () => () => undefined,
        startReview,
        createScheduledThreadAction,
      };
      let capturedStore: ComposerDraftStore | undefined;
      let reviewRequest: ComposerProps["reviewRequest"];
      const onReviewStarted = vi.fn();

      function Harness(props: {
        thread: NavigationThreadSummary;
        activeTurnId?: string;
        threadBusy?: boolean;
        request?: ComposerProps["reviewRequest"];
        remountKey?: number;
      }) {
        const store = useComposerDraftStore();
        capturedStore = store;
        return (
          <Composer
            key={props.remountKey ?? 0}
            activeTurnId={props.activeTurnId}
            backends={[codexBackend]}
            desktopApi={desktopApi}
            disabled={false}
            draftStore={store}
            onReviewRequestHandled={(id) => {
              if (reviewRequest?.id === id) {
                reviewRequest = undefined;
              }
            }}
            onReviewStarted={onReviewStarted}
            reviewRequest={props.request}
            skills={[]}
            thread={props.thread}
            threadBusy={props.threadBusy}
          />
        );
      }

      const busy = outcome === "queue-busy";
      const view = render(
        <Harness
          thread={threadA}
          activeTurnId={busy ? "active-turn-1" : undefined}
          threadBusy={busy}
        />,
      );

      if (entry === "type-review") {
        const input = screen.getByLabelText("Reply");
        fireEvent.change(input, { target: { value: "/review" } });
        await act(async () => {
          fireEvent.keyDown(input, { key: "Enter" });
        });
      } else if (entry === "slash-menu") {
        const input = screen.getByLabelText("Reply");
        fireEvent.change(input, { target: { value: "/rev" } });
        const option = await screen.findByRole("option", { name: /\/review/i });
        await act(async () => {
          fireEvent.click(option);
        });
      } else {
        reviewRequest = { id: 1, threadId: threadA.id, backend: "codex", todo: { id: "todo-a", allowOpenItems: true } };
        view.rerender(
          <Harness
            thread={threadA}
            activeTurnId={busy ? "active-turn-1" : undefined}
            threadBusy={busy}
            request={reviewRequest}
          />,
        );
      }

      await waitFor(() =>
        expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument(),
      );

      if (outcome === "start-immediate" || outcome === "queue-busy") {
        const currentChanges = screen.getByRole("button", { name: /Current changes/i });
        fireEvent.click(currentChanges);
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Start review" }));
        });
        await waitFor(() =>
          expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument(),
        );
      } else if (outcome === "cancel") {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        });
        expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
      }

      // Switch away to another thread, then return (optionally across a remount).
      view.rerender(<Harness thread={threadB} request={reviewRequest} remountKey={remountOnReturn ? 1 : 0} />);
      view.rerender(<Harness thread={threadA} request={reviewRequest} remountKey={remountOnReturn ? 2 : 0} />);

      expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Reply")).toHaveValue("");
      expect(capturedStore?.get(scopeA)).toBeUndefined();
      expect(capturedStore?.hasDraftContent(scopeA)).toBe(false);
      if (entry === "review-request" && outcome === "start-immediate") {
        await waitFor(() =>
          expect(onReviewStarted).toHaveBeenCalledWith("codex:thread-a", 1),
        );
      } else if (outcome === "queue-busy") {
        expect(onReviewStarted).not.toHaveBeenCalled();
        expect(createScheduledThreadAction).toHaveBeenCalledWith(expect.objectContaining({
          review: expect.objectContaining(entry === "review-request"
            ? { todo: { id: "todo-a", allowOpenItems: true } }
            : { target: { type: "uncommittedChanges" } }),
        }));
        // The queued row names the card it completes, so the card can say
        // its review is queued rather than offer Start review again.
        await waitFor(() =>
          expect(capturedStore?.getQueuedTurns(scopeA).map((queued) => queued.reviewTodoId)).toEqual(
            entry === "review-request" ? ["todo-a"] : [undefined],
          ),
        );
      }
    },
  );

  it("discards only the review placeholder when cancelling or leaving the panel", async () => {
    // Attachments were never submitted. Every exit must leave the same unsent
    // attachments in the active draft, whether React reuses the editor or not.
    for (const exit of ["cancel", "switch", "unmount"] as const) {
      for (const kind of ["image", "file", "both"] as const) {
        cleanup();
        const thread = makeThread("thread-a");
        const scope = buildThreadComposerScopeKey(thread.source, thread.id, { scope: "local" });
        const { result } = renderHook(() => useComposerDraftStore());
        const attachments = {
          imageAttachments: kind === "file" ? [] : [{ id: "image", name: "fixture.png", size: 1, type: "image/png", url: "data:image/png;base64,AA==" }],
          fileAttachments: kind === "image" ? [] : [{ id: "file", label: "fixture.txt", path: "/fixture.txt" }],
        };
        act(() => result.current.set(scope, { draft: "", skillTokens: [], ...attachments }));
        const composer = (owner: NavigationThreadSummary, key = 0) => (
          <Composer key={key} backends={[codexBackend]} disabled={false} draftStore={result.current} skills={[]} thread={owner} />
        );
        const view = render(composer(thread));
        await openReviewPanel();

        await act(async () => {
          if (exit === "cancel") {
            fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
          } else {
            view.rerender(composer(makeThread("thread-b"), exit === "unmount" ? 1 : 0));
          }
        });
        if (exit !== "cancel") {
          await act(async () => view.rerender(composer(thread, exit === "unmount" ? 2 : 0)));
        }

        expect(screen.getByLabelText("Reply")).toHaveValue("");
        expect(result.current.get(scope)).toMatchObject({ draft: "", ...attachments });
        expect(result.current.hasDraftContent(scope)).toBe(true);
        if (kind !== "file") expect(screen.getByRole("button", { name: "Remove fixture.png" })).toBeInTheDocument();
        if (kind !== "image") expect(screen.getByRole("button", { name: "Remove fixture.txt" })).toBeInTheDocument();
      }
    }
  });

  it("preserves the newest reply in the live editor and store when review admission fails", async () => {
    // The reply belongs to the user who wrote it, regardless of whether the
    // in-flight submission still has its original Composer instance.
    for (const remount of [true, false]) {
      cleanup();
      const thread = makeThread("thread-a");
      const scope = buildThreadComposerScopeKey(thread.source, thread.id, { scope: "local" });
      const { result } = renderHook(() => useComposerDraftStore());
      const receipt = Promise.withResolvers<never>();
      const createScheduledThreadAction = vi.fn(() => receipt.promise);
      const desktopApi: DesktopApi = { onAgentEvent: () => () => undefined, createScheduledThreadAction };
      const composer = (owner: NavigationThreadSummary, key = 0) => (
        <Composer key={key} backends={[codexBackend]} desktopApi={desktopApi} disabled={false}
          draftStore={result.current} skills={[]} thread={owner} threadBusy />
      );
      const view = render(composer(thread));
      await openReviewPanel();
      fireEvent.click(screen.getByRole("button", { name: /Current changes/i }));
      fireEvent.click(screen.getByRole("button", { name: "Start review" }));
      expect(createScheduledThreadAction).toHaveBeenCalledOnce();
      view.rerender(composer(makeThread("thread-b"), remount ? 1 : 0));
      view.rerender(composer(thread, remount ? 2 : 0));
      const reply = "New reply after returning";
      fireEvent.change(screen.getByLabelText("Reply"), { target: { value: reply } });

      await act(async () => receipt.reject(new Error("Review was rejected")));

      expect(screen.getByLabelText("Reply")).toHaveValue(reply);
      expect(result.current.get(scope)?.draft).toBe(reply);
    }
  });

  it("does not reopen the review creation screen in ThreadView after returning from an archived thread or launchpad", async () => {
    const threadA = makeThread("thread-a");
    const archivedThread = makeThread("thread-archived");
    const todo = makeReviewTodo(threadA);
    const resolve = vi.fn(async () => undefined);
    const todosView = makeTodosView(todo, resolve);
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: threadA.id,
      reviewThreadId: threadA.id,
      turnId: "review-turn-1",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      startReview,
    };

    function Harness(props: {
      selectedThread: NavigationThreadSummary;
      selectedThreadArchived?: boolean;
    }) {
      const store = useComposerDraftStore();
      const terminals = useIntegratedTerminals(desktopApi);
      const viewProps: ThreadViewProps = {
        addOptimisticUserMessage: () => "optimistic-1",
        backends: [codexBackend],
        clearPendingRequest: () => undefined,
        composerDisabled: false,
        composerDraftStore: store,
        desktopApi,
        loading: false,
        loadingMore: false,
        messageCount: 1,
        onLoadOlder: async () => undefined,
        removeOptimisticMessage: () => undefined,
        selectedThread: props.selectedThread,
        selectedThreadArchived: props.selectedThreadArchived,
        skills: [],
        terminals,
        threadTodos: todosView,
        transcriptEntries: [],
      };
      return <ThreadView {...viewProps} />;
    }

    const view = render(<Harness selectedThread={threadA} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    });
    const reviewGroup = await screen.findByRole("group", { name: "Review target" });
    fireEvent.click(screen.getByRole("button", { name: /Current changes/i }));
    await act(async () => {
      const startButtons = screen.getAllByRole("button", { name: "Start review" });
      fireEvent.click(startButtons.at(-1)!);
    });
    await waitFor(() => expect(startReview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(reviewGroup).not.toBeInTheDocument();

    // Switching to an archived thread unmounts the Composer; returning remounts it.
    view.rerender(<Harness selectedThread={archivedThread} selectedThreadArchived />);
    view.rerender(<Harness selectedThread={threadA} />);

    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("");
  });

  it("clears /review without clobbering another thread's draft when switching threads while a queued review request is in flight", async () => {
    const threadA = makeThread("thread-a");
    const threadB = makeThread("thread-b");
    const scopeA = buildThreadComposerScopeKey(threadA.source, threadA.id, { scope: "local" });
    const scopeB = buildThreadComposerScopeKey(threadB.source, threadB.id, { scope: "local" });
    const deferred = Promise.withResolvers<{
      action: {
        id: string;
        backend: "codex";
        threadId: string;
        kind: "review";
        origin: "desktop";
        status: "queued";
        queueEntryId: string;
        scheduledFor: number;
        createdAt: number;
        updatedAt: number;
        displayText: string;
      };
    }>();
    const createScheduledThreadAction = vi.fn(() => deferred.promise);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      createScheduledThreadAction,
    };
    let capturedStore: ComposerDraftStore | undefined;

    function Harness(props: { thread: NavigationThreadSummary; activeTurnId?: string; threadBusy?: boolean }) {
      const store = useComposerDraftStore();
      capturedStore = store;
      return (
        <Composer
          activeTurnId={props.activeTurnId}
          backends={[codexBackend]}
          desktopApi={desktopApi}
          disabled={false}
          draftStore={store}
          skills={[]}
          thread={props.thread}
          threadBusy={props.threadBusy}
        />
      );
    }

    const view = render(<Harness thread={threadA} activeTurnId="active-turn-1" threadBusy />);
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "/review" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    });
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Current changes/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    });
    expect(createScheduledThreadAction).toHaveBeenCalledTimes(1);

    // Switch to thread B and type a draft before thread A's queue request settles.
    view.rerender(<Harness thread={threadB} />);
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Keep this draft on B" } });

    await act(async () => {
      deferred.resolve({
        action: {
          id: "sched-review-1",
          backend: "codex",
          threadId: threadA.id,
          kind: "review",
          origin: "desktop",
          status: "queued",
          queueEntryId: "queue-review-1",
          scheduledFor: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          displayText: "Review current changes",
        },
      });
      await deferred.promise;
    });

    expect(screen.getByLabelText("Reply")).toHaveValue("Keep this draft on B");
    expect(capturedStore?.get(scopeB)?.draft).toBe("Keep this draft on B");
    expect(capturedStore?.get(scopeA)).toBeUndefined();

    // Return to thread A: no /review draft and no review creation panel.
    view.rerender(<Harness thread={threadA} activeTurnId="active-turn-1" threadBusy />);
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("");
    expect(capturedStore?.get(scopeA)).toBeUndefined();
  });
});
