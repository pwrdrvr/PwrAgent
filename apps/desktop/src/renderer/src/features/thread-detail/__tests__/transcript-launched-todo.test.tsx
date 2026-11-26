import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadLaunchedThread,
} from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ListThreadTodosRequest,
  ThreadTodo,
  ThreadTodosChangedEvent,
} from "@pwragent/shared/contracts/thread-todos";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import {
  dismissThreadTodoLaunch,
  launchThreadTodo,
  resetThreadTodoLaunchesForTests,
} from "../../thread-todos/thread-todo-launches";
import { TranscriptList } from "../TranscriptList";
import { useThreadLaunchedTodos } from "../useThreadLaunchedTodos";

type FederationWindowGlobal = typeof window & {
  __pwragentFederationTarget?: unknown;
  pwragent?: unknown;
};

afterEach(() => {
  cleanup();
  resetThreadTodoLaunchesForTests();
  delete (window as FederationWindowGlobal).__pwragentFederationTarget;
  delete (window as FederationWindowGlobal).pwragent;
});

function startedTodo(overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return {
    id: "todo-eval-1",
    backend: "acp:antigravity",
    threadId: "parent-thread",
    kind: "handoff",
    status: "done",
    title: "Inspect t3code evals and design PwrAgent in-repo eval framework",
    detail: "Compare harness layout and replay/staging gaps.",
    items: [
      { id: "pre-1", text: "Clone t3code", checked: true, prerequisite: true },
      { id: "step-1", text: "Audit t3code eval runner", checked: false },
      { id: "step-2", text: "Draft PwrAgent in-repo harness", checked: false },
    ],
    action: {
      type: "start_thread",
      title: "t3code Eval Framework",
      prompt: "Inspect `/Users/huntharo/github/t3code` and propose a PwrAgent eval suite.",
    },
    targetProject: {
      key: "directory:/Users/huntharo/github/t3code",
      label: "t3code",
      path: "/Users/huntharo/github/t3code",
    },
    result: "Started thread",
    startedThread: {
      backend: "acp:antigravity",
      threadId: "child-eval-thread",
    },
    createdAt: 1_000,
    updatedAt: 2_500,
    resolvedAt: 2_500,
    ...overrides,
  };
}

function threadSummary(overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id: "child-eval-thread",
    source: "acp:antigravity",
    title: "Live Renamed Eval Thread",
    titleSource: "generated",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...overrides,
  } as NavigationThreadSummary;
}

describe("TranscriptLaunchedTodo in TranscriptList", () => {
  it("renders launched card info and a clickable, live-updating ThreadChip in chronological order", () => {
    const onShowThread = vi.fn();
    const entries: AppServerThreadEntry[] = [
      { type: "message", id: "m-1", role: "assistant", text: "Captured as a to-do card.", createdAt: 2_000 },
      { type: "message", id: "m-2", role: "user", text: "Thanks!", createdAt: 3_000 },
    ];
    const todo = startedTodo();
    const view = render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[threadSummary()]}>
        <TranscriptList
          entries={entries}
          launchedTodos={[todo]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-entry-id", "m-1");
    expect(items[1]).toHaveAttribute("data-entry-id", "launched-todo:todo-eval-1");
    expect(items[2]).toHaveAttribute("data-entry-id", "m-2");

    // Card info is visible without expanding.
    expect(screen.getByText("Started thread")).toBeInTheDocument();
    expect(screen.getByText("Inspect t3code evals and design PwrAgent in-repo eval framework")).toBeInTheDocument();
    expect(screen.getByText("Compare harness layout and replay/staging gaps.")).toBeInTheDocument();
    expect(screen.getByText("t3code")).toBeInTheDocument();
    expect(screen.getByText("Antigravity")).toBeInTheDocument();
    expect(screen.getByText("2 plan steps")).toBeInTheDocument();

    // ThreadChip carries live title, is NOT nested inside the disclosure button, and navigates on click.
    const chip = screen.getByRole("button", { name: "Open thread Live Renamed Eval Thread" });
    const toggle = screen.getByRole("button", { name: /Started thread/ });
    expect(toggle.contains(chip)).toBe(false);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(chip);
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "acp:antigravity",
      threadId: "child-eval-thread",
    }));

    // Expanding reveals plan steps (not prerequisites) and the launched prompt.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Audit t3code eval runner")).toBeInTheDocument();
    expect(screen.getByText("Draft PwrAgent in-repo harness")).toBeInTheDocument();
    expect(screen.queryByText("Clone t3code")).not.toBeInTheDocument();
    expect(screen.getByText(/propose a PwrAgent eval suite/)).toBeInTheDocument();

    // Hovering the ThreadChip updates when the thread is renamed.
    view.rerender(
      <ThreadLinkProvider
        onShowThread={onShowThread}
        threads={[threadSummary({ title: "Updated Eval Title" })]}
      >
        <TranscriptList
          entries={entries}
          launchedTodos={[todo]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );
    expect(screen.getByRole("button", { name: "Open thread Updated Eval Title" })).toBeInTheDocument();
  });

  it("shows a ThreadInfoCard hover card on keyboard focus of the ThreadChip", async () => {
    render(
      <ThreadLinkProvider
        onShowThread={vi.fn()}
        threads={[threadSummary({ gitBranch: "feat/eval-harness", model: "gemini-4" })]}
      >
        <TranscriptList
          entries={[{ type: "message", id: "m-1", role: "assistant", text: "Done.", createdAt: 1_000 }]}
          launchedTodos={[startedTodo()]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );

    const chip = screen.getByRole("button", { name: "Open thread Live Renamed Eval Thread" });
    fireEvent.focus(chip);
    await waitFor(() => {
      expect(screen.getByText("feat/eval-harness")).toBeInTheDocument();
    });
    expect(screen.getByText("child-eval-thread")).toBeInTheDocument();
  });

  it("renders setup failure badge, preview, and expanded error details without crashing", () => {
    const failed = startedTodo({
      id: "todo-setup-fail",
      result: "Started thread. Its environment setup failed. Peer could not create a worktree.",
      startedThread: {
        backend: "codex",
        threadId: "child-fail",
        setupFailure: "pnpm install exited with code 1",
      },
    });
    render(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[]}>
        <TranscriptList
          entries={[{ type: "message", id: "m-1", role: "assistant", text: "Done.", createdAt: 1_000 }]}
          launchedTodos={[failed]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );

    expect(screen.getByText("Setup failed")).toBeInTheDocument();
    expect(screen.getByText("pnpm install exited with code 1")).toBeInTheDocument();
    expect(screen.getByText("Peer could not create a worktree.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Started thread/ }));
    expect(screen.getByText("Environment setup failed")).toBeInTheDocument();
  });

  it("handles remote viewer window framing: no self-popout on owner threads and main-window open on local threads", () => {
    const PEER = "pwr_peer_m5";
    const LOCAL = "pwr_local_m2";
    const openThreadInMainWindow = vi.fn(async () => undefined);
    const global = window as FederationWindowGlobal;
    global.__pwragentFederationTarget = { scope: "remote", instanceId: PEER };
    global.pwragent = { openThreadInMainWindow };

    const onShowThread = vi.fn();
    const peerStartedOnPeer = startedTodo({
      id: "peer-on-peer",
      federationTarget: { scope: "remote", instanceId: PEER },
      startedThread: { backend: "codex", threadId: "peer-child-1" },
      resolvedAt: 2_000,
    });
    const peerStartedOnLocal = startedTodo({
      id: "peer-on-local",
      title: "Run locally on M2",
      action: { type: "start_thread", title: "Local Child", prompt: "Run here" },
      federationTarget: { scope: "remote", instanceId: PEER },
      startedThread: {
        backend: "claude",
        threadId: "local-child-2",
        instanceId: LOCAL,
        instanceLabel: "M2 Max",
      },
      resolvedAt: 2_500,
    });

    render(
      <ThreadLinkProvider
        localInstanceId={LOCAL}
        onOpenRemoteViewer={vi.fn()}
        onShowThread={onShowThread}
        threads={[threadSummary({ id: "peer-child-1", source: "codex", title: "Peer Own Child" })]}
      >
        <TranscriptList
          entries={[{ type: "message", id: "m-1", role: "assistant", text: "Hi", createdAt: 1_000 }]}
          launchedTodos={[peerStartedOnPeer, peerStartedOnLocal]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );

    // Neither chip should show a remote-viewer pop-out (one is this window's owner, one is local).
    expect(screen.queryByRole("button", { name: /^Open remote viewer/ })).toBeNull();

    // Clicking the peer's own child opens it inside this remote viewer window.
    fireEvent.click(screen.getByRole("button", { name: "Open thread Peer Own Child" }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      threadId: "peer-child-1",
    }));

    // Clicking the child started on this machine opens it in the main window.
    fireEvent.click(screen.getByRole("button", { name: "Open thread Local Child" }));
    expect(openThreadInMainWindow).toHaveBeenCalledWith({
      backend: "claude",
      threadId: "local-child-2",
    });
  });

  it("shows a launched card immediately from the launch tray, deduplicates on reload, and keeps it after dismissal", async () => {
    const listeners = new Set<(event: ThreadTodosChangedEvent) => void>();
    let storedTodos: ThreadTodo[] = [];
    const listThreadTodos = vi.fn(async (_request?: ListThreadTodosRequest) => ({ todos: storedTodos }));
    const api = {
      listThreadTodos,
      onThreadTodosChanged: (listener: (event: ThreadTodosChangedEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const threadKey = "acp:antigravity:parent-thread";

    function Harness(props: { threadId: string }) {
      const launched = useThreadLaunchedTodos({
        desktopApi: api,
        thread: { backend: "acp:antigravity", threadId: props.threadId },
        threadKey: `acp:antigravity:${props.threadId}`,
      });
      return (
        <ThreadLinkProvider onShowThread={vi.fn()} threads={[]}>
          <TranscriptList
            entries={[{ type: "message", id: "m-1", role: "assistant", text: "Ready.", createdAt: 1_000 }]}
            launchedTodos={launched}
            loading={false}
            loadingMore={false}
            onLoadOlder={async () => undefined}
          />
        </ThreadLinkProvider>
      );
    }

    const view = render(<Harness threadId="parent-thread" />);
    await waitFor(() => expect(listThreadTodos).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Started thread")).toBeNull();

    const completed = startedTodo();
    await act(async () => {
      await launchThreadTodo(
        { todo: { ...completed, status: "open", startedThread: undefined }, threadKey },
        async (begin) => {
          begin();
          return completed;
        },
      );
    });

    // Immediately visible in transcript before the IPC reload has even fired!
    expect(screen.getAllByText("Started thread")).toHaveLength(1);

    // Owner persists and broadcasts change -> reloads -> still deduplicated to 1 card.
    storedTodos = [completed];
    await act(async () => {
      for (const listener of listeners) {
        listener({ at: 2_600, backend: "acp:antigravity", threadId: "parent-thread" });
      }
    });
    await waitFor(() => expect(listThreadTodos).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("Started thread")).toHaveLength(1);

    // Tray dismisses after its countdown -> card stays in transcript!
    act(() => {
      dismissThreadTodoLaunch(completed.id);
    });
    expect(screen.getAllByText("Started thread")).toHaveLength(1);

    // Switching to another thread clears immediately with zero bleed.
    view.rerender(<Harness threadId="other-thread" />);
    expect(screen.queryByText("Started thread")).toBeNull();
  });

  it("renders tool-launched child threads (handoff_task, fork, and create_instance_thread) with live ThreadChip and deduplicates against to-do cards", () => {
    const onShowThread = vi.fn();
    const handoffLaunch: ThreadLaunchedThread = {
      id: "handoff:codex:parent:turn-1:call-1",
      source: "handoff_task",
      occurredAt: 2_100,
      title: "Add signing-key cache in atlas-auth",
      projectLabel: "atlas-auth",
      startedThread: {
        backend: "codex",
        threadId: "handoff-child-1",
      },
      seedMode: "clean",
      groupingMode: "subthread",
      workspaceMode: "new_worktree",
    };
    const forkedLaunch: ThreadLaunchedThread = {
      id: "handoff:codex:parent:turn-2:call-2",
      source: "handoff_task",
      occurredAt: 2_400,
      title: "Explore alternate retry policy",
      projectLabel: "atlas",
      startedThread: {
        backend: "claude",
        threadId: "fork-child-2",
      },
      seedMode: "fork",
      groupingMode: "none",
      turnStartFailure: "Backend busy on initial turn",
    };
    const remoteToolLaunch: ThreadLaunchedThread = {
      id: "create_instance_thread:peer-m3:codex:remote-child-3",
      source: "create_instance_thread",
      occurredAt: 2_600,
      title: "Run GPU benchmark on M3 Studio",
      projectLabel: "atlas-bench",
      startedThread: {
        backend: "codex",
        threadId: "remote-child-3",
        instanceId: "peer-m3",
        instanceLabel: "M3 Studio",
      },
      groupingMode: "none",
      workspaceMode: "worktree",
    };
    // Duplicate of the to-do launch's started child thread — should deduplicate cleanly.
    const duplicateOfTodo: ThreadLaunchedThread = {
      id: "dup-tool-entry",
      source: "create_instance_thread",
      occurredAt: 2_550,
      title: "Duplicate tool entry",
      startedThread: {
        backend: "acp:antigravity",
        threadId: "child-eval-thread",
      },
    };

    render(
      <ThreadLinkProvider
        localInstanceId="local-m5"
        onOpenRemoteViewer={vi.fn()}
        onShowThread={onShowThread}
        threads={[
          threadSummary({ id: "handoff-child-1", source: "codex", title: "Live Handoff Title" }),
          threadSummary({ id: "fork-child-2", source: "claude", title: "Live Fork Title" }),
        ]}
      >
        <TranscriptList
          entries={[
            { type: "message", id: "u-1", role: "user", text: "Kick off the follow-ups.", createdAt: 1_000 },
            { type: "message", id: "a-1", role: "assistant", text: "Done.", createdAt: 3_000 },
          ]}
          launchedThreads={[handoffLaunch, forkedLaunch, remoteToolLaunch, duplicateOfTodo]}
          launchedTodos={[startedTodo()]}
          loading={false}
          loadingMore={false}
          onLoadOlder={async () => undefined}
        />
      </ThreadLinkProvider>,
    );

    // 4 cards total: 1 todo + 3 distinct tool launches (duplicateOfTodo suppressed).
    expect(screen.queryByText("Duplicate tool entry")).toBeNull();
    expect(screen.getByText("Handed off thread")).toBeInTheDocument();
    expect(screen.getByText("Forked thread")).toBeInTheDocument();
    expect(screen.getAllByText("Started thread")).toHaveLength(2);
    expect(screen.getByText("Turn failed")).toBeInTheDocument();

    // Live ThreadChip resolves renamed title and navigates on click.
    fireEvent.click(screen.getByRole("button", { name: "Open thread Live Handoff Title" }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      threadId: "handoff-child-1",
    }));

    // Expanding the forked card reveals the turn start failure.
    fireEvent.click(screen.getByRole("button", { name: /Forked thread/ }));
    expect(screen.getByText("Initial turn failed")).toBeInTheDocument();
    expect(screen.getByText("Backend busy on initial turn")).toBeInTheDocument();
  });
});
