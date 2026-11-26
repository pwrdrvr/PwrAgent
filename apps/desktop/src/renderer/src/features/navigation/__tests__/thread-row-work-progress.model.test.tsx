import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadGitWorkingState } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { ThreadTodoCountsContext } from "../../thread-todos/useThreadTodos";
import { ThreadRow } from "../ThreadRow";
import {
  stepThreadRowWorkProgress,
  type ThreadRowWorkProgressState,
} from "../thread-row-work-progress";

afterEach(cleanup);

// The rule (apps/desktop/docs/thread-row-density.md, "Working rows hold their
// progress chips"): while a thread is mid-turn and not the open thread, its
// row keeps the git and to-do chips it showed when it went quiet. Opening the
// thread, or the turn ending, shows the live values at once. Chips that wait
// on the operator stay live throughout, and no row shows the branch-drift
// chip; that warning belongs to the open thread. A turn is running while the
// backend says so, an owned worker runs, or the renderer is waiting on the
// turn's status; background tasks left running after it do not count.
//
// Generated sequences over the pure model live in
// `thread-row-work-progress.property.test.ts` (desktop-renderer-node). This
// file ties that pure model to a real mounted `ThreadRow` against an idle
// oracle row, and keeps the shrunk counterexamples.

const thread: NavigationThreadSummary = {
  id: "quiet-row",
  title: "Contrived working thread",
  titleSource: "explicit",
  source: "codex",
  gitBranch: "HEAD",
  executionMode: "default",
  updatedAt: 1,
  inbox: { inInbox: false },
  linkedDirectories: [],
};
const threadKey = threadSummaryIdentityKey(thread);

type Activity = {
  thinking?: boolean;
  turnActive?: boolean;
  subAgent?: boolean;
  background?: boolean;
};

type MountedStep = {
  activity?: Activity;
  selected?: boolean;
  approval?: boolean;
  gitBranch?: string;
  observedGitBranch?: string;
  gitWorkingState?: ThreadGitWorkingState;
  todos?: ThreadTodo[];
  remount?: boolean;
};

/** What a reader compares between two rows: each chip's kind, text and name. */
function chipFlow(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".thread-row__chips .thread-row__chip")].map((chip) =>
    [chip.className, chip.textContent ?? "", chip.getAttribute("aria-label") ?? ""].join(" | "));
}

function makeTodo(index: number): ThreadTodo {
  return {
    id: `todo-${index}`,
    backend: "codex",
    threadId: thread.id,
    kind: "reminder",
    status: "open",
    title: `Contrived card ${index}`,
    createdAt: index,
    updatedAt: index,
  };
}

function renderOracleOrSubject(params: {
  summary: NavigationThreadSummary;
  todos: readonly ThreadTodo[];
  selected: boolean;
  approval: boolean;
  thinking: boolean;
}) {
  return (
    <ThreadTodoCountsContext.Provider value={new Map([[threadKey, [...params.todos]]])}>
      <ThreadRow
        approvalRequestThreadKeys={params.approval ? { [threadKey]: true } : undefined}
        selectedThreadKey={params.selected ? threadKey : undefined}
        thinkingThreadKeys={params.thinking ? { [threadKey]: true } : undefined}
        thread={params.summary}
        onOpenContextMenu={() => undefined}
        onSelectThread={() => undefined}
      />
    </ThreadTodoCountsContext.Provider>
  );
}

/**
 * Replays a sequence through both the real mounted `ThreadRow` and the pure
 * `stepThreadRowWorkProgress` model, checking that the row's chip flow matches
 * an idle oracle row rendered from the model's expected summary at every step.
 */
function expectMountedRowMatchesPureModel(steps: readonly MountedStep[]): void {
  let modelState: ThreadRowWorkProgressState | undefined;
  let subject: ReturnType<typeof render> | undefined;
  let oracle: ReturnType<typeof render> | undefined;
  try {
    for (const step of steps) {
      const activity = step.activity ?? {};
      const selected = step.selected === true;
      const approval = step.approval === true;
      const thinking = activity.thinking === true;
      const todos = step.todos ?? [];
      const liveThread: NavigationThreadSummary = {
        ...thread,
        gitBranch: step.gitBranch,
        observedGitBranch: step.observedGitBranch,
        gitWorkingState: step.gitWorkingState,
        threadStatus: activity.turnActive ? "active" : "idle",
        hasActiveSubAgent: activity.subAgent === true,
        hasBackgroundTasks: activity.background === true,
      };
      const { state, shown } = stepThreadRowWorkProgress(modelState, {
        thread: liveThread,
        openTodos: todos,
        selectedThreadKey: selected ? threadKey : undefined,
        thinkingThreadKeys: thinking ? { [threadKey]: true } : undefined,
        remount: step.remount,
      });
      modelState = state;

      const subjectTree = renderOracleOrSubject({
        summary: liveThread,
        todos,
        selected,
        approval,
        thinking,
      });
      if (!subject || step.remount) {
        subject?.unmount();
        subject = render(subjectTree);
      } else {
        subject.rerender(subjectTree);
      }

      const oracleTree = renderOracleOrSubject({
        summary: {
          ...shown.thread,
          threadStatus: "idle",
          hasActiveSubAgent: false,
          hasBackgroundTasks: false,
        },
        todos: shown.openTodos,
        selected: false,
        approval,
        thinking: false,
      });
      if (!oracle) {
        oracle = render(oracleTree);
      } else {
        oracle.rerender(oracleTree);
      }

      const chips = chipFlow(subject.container);
      expect(chips).toEqual(chipFlow(oracle.container));
      // Waiting on the operator is never held.
      expect(Boolean(subject.container.querySelector(".thread-row__chip--approval"))).toBe(approval);
      // The drift warning lives in the open thread, not the row.
      expect(chips.some((chip) => chip.includes("| now "))).toBe(false);
    }
  } finally {
    subject?.unmount();
    oracle?.unmount();
  }
}

const unpushed = (count: number): ThreadGitWorkingState => ({
  dirtyFiles: 0,
  dirtyAdditions: 0,
  dirtyDeletions: 0,
  untrackedFiles: 0,
  unpushedCommits: count,
});

const dirtyAndAhead: ThreadGitWorkingState = {
  dirtyFiles: 2,
  dirtyAdditions: 42,
  dirtyDeletions: 7,
  untrackedFiles: 1,
  unpushedCommits: 2,
  baseBranch: "main",
  baseAheadCommitCount: 2,
};

it("matches the pure hold model across active turns, selection, approvals, drift and background tasks", () => {
  const firstTodo = makeTodo(1);
  const secondTodo = makeTodo(2);
  const thirdTodo = makeTodo(3);
  expectMountedRowMatchesPureModel([
    // Two consecutive idle updates before the hold begins: ensures `useHeldWhile`
    // refreshes its committed snapshot across unheld renders rather than snapping
    // back to the initial mount when a turn later starts.
    { gitBranch: "HEAD" },
    {
      gitBranch: "main",
      gitWorkingState: unpushed(1),
      todos: [firstTodo],
    },
    // Two consecutive progress-changing updates while held: ensures `useHeldWhile`
    // keeps the pre-turn snapshot (`committed.current = shown`) instead of lagging
    // by one render (`committed.current = value`). Approvals stay live throughout.
    {
      activity: { turnActive: true },
      approval: true,
      gitBranch: "fix/contrived-branch",
      observedGitBranch: "test/another-contrived-branch",
      gitWorkingState: dirtyAndAhead,
      todos: [firstTodo, secondTodo],
    },
    {
      activity: { turnActive: true },
      approval: true,
      gitBranch: "test/another-contrived-branch",
      observedGitBranch: "fix/contrived-branch",
      gitWorkingState: unpushed(4),
      todos: [firstTodo, secondTodo, thirdTodo],
    },
    // Opening the thread reveals every live chip while the turn still runs.
    {
      activity: { turnActive: true },
      selected: true,
      approval: false,
      gitBranch: "test/another-contrived-branch",
      observedGitBranch: "fix/contrived-branch",
      gitWorkingState: unpushed(4),
      todos: [firstTodo, secondTodo, thirdTodo],
    },
    // Leaving it holds what was shown while open across multiple mid-turn updates.
    {
      activity: { turnActive: true },
      selected: false,
      gitBranch: "main",
      observedGitBranch: "main",
      gitWorkingState: unpushed(5),
      todos: [firstTodo],
    },
    {
      activity: { turnActive: true },
      selected: false,
      gitBranch: "fix/contrived-branch",
      observedGitBranch: "fix/contrived-branch",
      gitWorkingState: dirtyAndAhead,
      todos: [],
    },
    // Turn finishes with a background task still running: live chips appear at once.
    {
      activity: { background: true },
      gitBranch: "fix/contrived-branch",
      observedGitBranch: "fix/contrived-branch",
      gitWorkingState: dirtyAndAhead,
      todos: [],
    },
  ]);
});

it("matches the pure hold model across owned workers, thinking state and mid-turn remounts", () => {
  const firstTodo = makeTodo(1);
  const secondTodo = makeTodo(2);
  expectMountedRowMatchesPureModel([
    // Mounted mid-turn with an owned worker: shows its initial live values.
    {
      activity: { subAgent: true },
      gitBranch: "HEAD",
      gitWorkingState: dirtyAndAhead,
      todos: [firstTodo],
    },
    // Multiple subsequent changes while the worker runs stay held at the mount snapshot.
    {
      activity: { subAgent: true },
      gitBranch: "fix/contrived-branch",
      gitWorkingState: undefined,
      todos: [],
    },
    {
      activity: { subAgent: true },
      gitBranch: "main",
      gitWorkingState: unpushed(3),
      todos: [firstTodo, secondTodo],
    },
    // Remounting mid-turn drops the prior held snapshot and shows live values.
    {
      activity: { subAgent: true },
      gitBranch: "fix/contrived-branch",
      gitWorkingState: unpushed(1),
      todos: [firstTodo],
      remount: true,
    },
    // Pending renderer thinking holds new changes until thinking clears.
    {
      activity: { thinking: true },
      gitBranch: "main",
      gitWorkingState: unpushed(2),
      todos: [],
    },
    {
      activity: {},
      gitBranch: "main",
      gitWorkingState: unpushed(2),
      todos: [],
    },
  ]);
});

function renderRow(params: {
  working: boolean;
  selected: boolean;
  gitWorkingState?: ThreadGitWorkingState;
  todos?: ThreadTodo[];
}) {
  return (
    <ThreadTodoCountsContext.Provider value={new Map([[threadKey, params.todos ?? []]])}>
      <ThreadRow
        selectedThreadKey={params.selected ? threadKey : undefined}
        thinkingThreadKeys={params.working ? { [threadKey]: true } : undefined}
        thread={{ ...thread, gitBranch: "fix/contrived-branch", gitWorkingState: params.gitWorkingState }}
        onOpenContextMenu={() => undefined}
        onSelectThread={() => undefined}
      />
    </ThreadTodoCountsContext.Provider>
  );
}

// The model's first shrunk counterexample on the pre-fix row.
it("keeps a commit made mid-turn off an unopened row until the turn ends", () => {
  const view = render(renderRow({ working: true, selected: false }));
  const unpushedChip = () => view.container.querySelector(".thread-row__chip--unpushed");

  view.rerender(renderRow({ working: true, selected: false, gitWorkingState: unpushed(1) }));
  expect(unpushedChip()).toBeNull();

  // Opening the thread shows the live count at once.
  view.rerender(renderRow({ working: true, selected: true, gitWorkingState: unpushed(1) }));
  expect(unpushedChip()).toHaveTextContent("↑1");

  // Leaving it holds what it showed, not what it showed before it was opened.
  view.rerender(renderRow({ working: true, selected: false, gitWorkingState: unpushed(2) }));
  expect(unpushedChip()).toHaveTextContent("↑1");

  view.rerender(renderRow({ working: false, selected: false, gitWorkingState: unpushed(2) }));
  expect(unpushedChip()).toHaveTextContent("↑2");
});

it("keeps the open thread's to-do count live mid-turn", () => {
  const todo: ThreadTodo = {
    id: "todo-1", backend: "codex", threadId: thread.id, kind: "reminder",
    status: "open", title: "Contrived card", createdAt: 1, updatedAt: 1,
  };
  const count = (view: ReturnType<typeof render>) =>
    view.container.querySelector("[data-thread-todos]")?.getAttribute("data-thread-todos") ?? "0";

  const open = render(renderRow({ working: true, selected: true }));
  open.rerender(renderRow({ working: true, selected: true, todos: [todo] }));
  expect(count(open)).toBe("1");
  open.unmount();

  const unopened = render(renderRow({ working: true, selected: false }));
  unopened.rerender(renderRow({ working: true, selected: false, todos: [todo] }));
  expect(count(unopened)).toBe("0");
  unopened.rerender(renderRow({ working: false, selected: false, todos: [todo] }));
  expect(count(unopened)).toBe("1");
});

it("shows live chips once the turn ends, even with background tasks still running", () => {
  const backgroundOnly = (gitWorkingState?: ThreadGitWorkingState) => (
    <ThreadRow
      thread={{ ...thread, gitBranch: "fix/contrived-branch", threadStatus: "idle", hasBackgroundTasks: true, gitWorkingState }}
      onOpenContextMenu={() => undefined}
      onSelectThread={() => undefined}
    />
  );
  const view = render(backgroundOnly());
  view.rerender(backgroundOnly(unpushed(1)));
  expect(view.container.querySelector(".thread-row__chip--unpushed")).toHaveTextContent("↑1");
});
