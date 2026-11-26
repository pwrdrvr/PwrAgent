import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadGitWorkingState } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import {
  stepThreadRowWorkProgress,
  type ThreadRowWorkProgressState,
} from "../thread-row-work-progress";

// The rule (apps/desktop/docs/thread-row-density.md, "Working rows hold their
// progress chips"): while a thread is mid-turn and not the open thread, its
// row keeps the git and to-do chips it showed when it went quiet. Opening the
// thread, or the turn ending, shows the live values at once. A row that mounts
// mid-turn has nothing older to show, so it shows its first value. Every other
// thread field stays live throughout. A turn is running while the backend says
// so, an owned worker runs, or the renderer is waiting on the turn's status;
// background tasks left running after it do not count.

const baseThread: NavigationThreadSummary = {
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
const threadKey = threadSummaryIdentityKey(baseThread);

type Progress = {
  gitWorkingState?: ThreadGitWorkingState;
  gitBranch?: string;
  observedGitBranch?: string;
  todos: ThreadTodo[];
};

type Activity = {
  thinking: boolean;
  turnActive: boolean;
  subAgent: boolean;
  background: boolean;
};

const IDLE: Activity = {
  thinking: false,
  turnActive: false,
  subAgent: false,
  background: false,
};

const branch = fc.constantFrom(
  undefined,
  "HEAD",
  "main",
  "fix/contrived-branch",
  "test/another-contrived-branch",
);

const command = fc.oneof(
  fc.record({
    kind: fc.constant("activity" as const),
    source: fc.constantFrom<keyof Activity>(
      "thinking",
      "turnActive",
      "subAgent",
      "background",
    ),
  }),
  fc.record({ kind: fc.constant("select" as const) }),
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
  fc.record({
    kind: fc.constant("branch" as const),
    gitBranch: branch,
    observedGitBranch: branch,
  }),
  fc.record({ kind: fc.constant("todo" as const), add: fc.boolean() }),
  fc.record({ kind: fc.constant("title" as const), suffix: fc.nat({ max: 20 }) }),
);

describe("thread-row work-progress hold model", () => {
  it("holds git and to-do progress while an unopened row's turn runs and keeps non-progress fields live", () => {
    fc.assert(
      fc.property(
        fc.array(command, { minLength: 6, maxLength: 24, size: "max" }),
        (commands) => {
          let activity: Activity = IDLE;
          let selected = false;
          let title = baseThread.title;
          let live: Progress = { gitBranch: baseThread.gitBranch, todos: [] };
          let expected: Progress = live;
          let nextTodo = 0;

          const buildThread = (progress: Progress, rowActivity: Activity): NavigationThreadSummary => ({
            ...baseThread,
            title,
            gitBranch: progress.gitBranch,
            observedGitBranch: progress.observedGitBranch,
            gitWorkingState: progress.gitWorkingState,
            threadStatus: rowActivity.turnActive ? "active" : "idle",
            hasActiveSubAgent: rowActivity.subAgent,
            hasBackgroundTasks: rowActivity.background,
          });

          let state: ThreadRowWorkProgressState | undefined;
          ({ state } = stepThreadRowWorkProgress(state, {
            thread: buildThread(live, activity),
            openTodos: live.todos,
            selectedThreadKey: selected ? threadKey : undefined,
            thinkingThreadKeys: activity.thinking ? { [threadKey]: true } : undefined,
          }));

          for (const step of commands) {
            switch (step.kind) {
              case "activity":
                activity = { ...activity, [step.source]: !activity[step.source] };
                break;
              case "select":
                selected = !selected;
                break;
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
              case "clean":
                live = { ...live, gitWorkingState: undefined };
                break;
              case "branch":
                live = {
                  ...live,
                  gitBranch: step.gitBranch,
                  observedGitBranch: step.observedGitBranch,
                };
                break;
              case "todo": {
                const todos = step.add
                  ? [
                      ...live.todos,
                      {
                        id: `todo-${nextTodo}`,
                        backend: "codex",
                        threadId: baseThread.id,
                        kind: "reminder",
                        status: "open",
                        title: `Contrived card ${nextTodo}`,
                        createdAt: nextTodo,
                        updatedAt: nextTodo,
                      } satisfies ThreadTodo,
                    ]
                  : live.todos.slice(1);
                nextTodo++;
                live = { ...live, todos };
                break;
              }
              case "title":
                title = `Contrived working thread ${step.suffix}`;
                break;
              case "remount":
                break;
            }

            const liveThread = buildThread(live, activity);
            const result = stepThreadRowWorkProgress(state, {
              thread: liveThread,
              openTodos: live.todos,
              selectedThreadKey: selected ? threadKey : undefined,
              thinkingThreadKeys: activity.thinking ? { [threadKey]: true } : undefined,
              remount: step.kind === "remount",
            });
            state = result.state;

            const turnRunning =
              activity.thinking || activity.turnActive || activity.subAgent;
            const shouldHold = !selected && turnRunning;
            if (step.kind === "remount" || !shouldHold) {
              expected = live;
            }

            expect(result.shown.hold).toBe(shouldHold);
            expect(result.shown.thread.gitBranch).toBe(expected.gitBranch);
            expect(result.shown.thread.observedGitBranch).toBe(expected.observedGitBranch);
            expect(result.shown.thread.gitWorkingState).toBe(expected.gitWorkingState);
            expect(result.shown.openTodos).toBe(expected.todos);

            // Non-progress fields always stay live, even while held.
            expect(result.shown.thread.title).toBe(liveThread.title);
            expect(result.shown.thread.threadStatus).toBe(liveThread.threadStatus);
            expect(result.shown.thread.hasActiveSubAgent).toBe(liveThread.hasActiveSubAgent);
            expect(result.shown.thread.hasBackgroundTasks).toBe(liveThread.hasBackgroundTasks);
          }
        },
      ),
    );
  });
});
