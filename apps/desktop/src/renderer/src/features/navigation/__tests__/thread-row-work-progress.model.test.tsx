import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadGitWorkingState } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { ThreadTodoCountsContext } from "../../thread-todos/useThreadTodos";
import { ThreadRow } from "../ThreadRow";

afterEach(cleanup);

// The rule (apps/desktop/docs/thread-row-density.md, "Working rows hold their
// progress chips"): while a thread is mid-turn and not the open thread, its
// row keeps the git and to-do chips it showed when it went quiet. Opening the
// thread, or the turn ending, shows the live values at once. Chips that wait
// on the operator stay live throughout, and no row shows the branch-drift
// chip; that warning belongs to the open thread.
//
// Oracle: a second, idle row rendered from the model's expected summary. The
// two chip flows must match, so the test never restates how a chip renders.

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

type Progress = {
  gitWorkingState?: ThreadGitWorkingState;
  gitBranch?: string;
  observedGitBranch?: string;
  todos: ThreadTodo[];
};

const branch = fc.constantFrom(undefined, "HEAD", "main", "fix/contrived-branch", "test/another-contrived-branch");
const command = fc.oneof(
  fc.record({ kind: fc.constant("working" as const) }),
  fc.record({ kind: fc.constant("select" as const) }),
  fc.record({ kind: fc.constant("approval" as const) }),
  fc.record({ kind: fc.constant("remount" as const) }),
  fc.record({
    kind: fc.constant("git" as const),
    dirty: fc.nat({ max: 3 }),
    additions: fc.nat({ max: 400 }),
    deletions: fc.nat({ max: 60 }),
    untracked: fc.nat({ max: 2 }),
    unpushed: fc.nat({ max: 3 }),
    ahead: fc.nat({ max: 3 }),
  }),
  fc.record({ kind: fc.constant("clean" as const) }),
  fc.record({ kind: fc.constant("branch" as const), gitBranch: branch, observedGitBranch: branch }),
  fc.record({ kind: fc.constant("todo" as const), add: fc.boolean() }),
);

/** What a reader compares between two rows: each chip's kind, text and name. */
function chipFlow(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".thread-row__chips .thread-row__chip")].map((chip) =>
    [chip.className, chip.textContent ?? "", chip.getAttribute("aria-label") ?? ""].join(" | "));
}

it("holds a working, unopened row's progress chips until it is opened or idle", () => {
  fc.assert(fc.property(fc.array(command, { minLength: 10, maxLength: 40, size: "max" }), (commands) => {
    let working = false;
    let selected = false;
    let approval = false;
    let live: Progress = { gitBranch: thread.gitBranch, todos: [] };
    let shown: Progress = live;
    let nextTodo = 0;

    const row = (progress: Progress, rowWorking: boolean, rowSelected: boolean) => {
      const { todos, ...git } = progress;
      return (
        <ThreadTodoCountsContext.Provider value={new Map([[threadKey, todos]])}>
          <ThreadRow
            approvalRequestThreadKeys={approval ? { [threadKey]: true } : undefined}
            selectedThreadKey={rowSelected ? threadKey : undefined}
            thinkingThreadKeys={rowWorking ? { [threadKey]: true } : undefined}
            thread={{ ...thread, ...git }}
            onOpenContextMenu={() => undefined}
            onSelectThread={() => undefined}
          />
        </ThreadTodoCountsContext.Provider>
      );
    };

    let subject = render(row(live, working, selected));
    try {
      for (const step of commands) {
        switch (step.kind) {
          case "working": working = !working; break;
          case "select": selected = !selected; break;
          case "approval": approval = !approval; break;
          case "git":
            live = {
              ...live,
              gitWorkingState: {
                dirtyFiles: step.dirty,
                dirtyAdditions: step.dirty ? step.additions : 0,
                dirtyDeletions: step.dirty ? step.deletions : 0,
                untrackedFiles: step.untracked,
                unpushedCommits: step.unpushed,
                baseBranch: "main",
                baseAheadCommitCount: step.ahead,
              },
            };
            break;
          case "clean": live = { ...live, gitWorkingState: undefined }; break;
          case "branch": live = { ...live, gitBranch: step.gitBranch, observedGitBranch: step.observedGitBranch }; break;
          case "todo": {
            const todos = step.add
              ? [...live.todos, {
                id: `todo-${nextTodo}`, backend: "codex", threadId: thread.id, kind: "reminder",
                status: "open", title: `Contrived card ${nextTodo}`, createdAt: nextTodo, updatedAt: nextTodo,
              } satisfies ThreadTodo]
              : live.todos.slice(1);
            nextTodo++;
            live = { ...live, todos };
            break;
          }
          case "remount": break;
        }

        if (step.kind === "remount") {
          subject.unmount();
          subject = render(row(live, working, selected));
          // A row that mounts mid-turn has nothing older to show.
          shown = live;
        } else {
          subject.rerender(row(live, working, selected));
        }
        if (!working || selected) shown = live;

        const oracle = render(row(shown, false, false));
        try {
          expect(chipFlow(subject.container)).toEqual(chipFlow(oracle.container));
        } finally {
          oracle.unmount();
        }
        // Waiting on the operator is never held.
        expect(Boolean(subject.container.querySelector(".thread-row__chip--approval"))).toBe(approval);
        // The drift warning lives in the open thread, not the row.
        expect(chipFlow(subject.container).some((chip) => chip.includes("| now "))).toBe(false);
      }
    } finally {
      subject.unmount();
    }
  }), { numRuns: 25 });
});

const unpushed = (count: number): ThreadGitWorkingState => ({
  dirtyFiles: 0,
  dirtyAdditions: 0,
  dirtyDeletions: 0,
  untrackedFiles: 0,
  unpushedCommits: count,
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
