import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadPendingWake,
  ThreadPendingWakeEnded,
  ThreadPendingWakesResponse,
} from "@pwragent/shared";
import type {
  ThreadPendingWakesController,
  ThreadPendingWakesState,
} from "../../../thread-pending-wakes/useThreadPendingWakes";
import { WaitingForPanel } from "../WaitingForPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Local noon, so formatted times stay on one day in every timezone.
const NOW = new Date(2026, 10, 1, 16, 0).getTime();
const at = (hour: number, minute = 0): number => new Date(2026, 10, 1, hour, minute).getTime();

const thread: NavigationThreadSummary = {
  id: "waiting",
  title: "Release sandboxes when a PR closes",
  titleSource: "explicit",
  source: "claude",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

const WAKES: ThreadPendingWake[] = [
  {
    kind: "scheduled_action", key: "scheduled_action:a1", actionId: "a1", actionKind: "turn", status: "scheduled",
    displayText: "Rebase on main and re-run shard 2.", createdAt: at(13, 12), wakesAt: at(16, 30),
    createdBy: "operator", durable: true, stop: "cancel",
  },
  {
    kind: "pr_watch", key: "pr_watch:w1", durable: true, stop: "stop", createdBy: "agent", createdAt: at(15, 3),
    watch: {
      watchId: "w1", backend: "claude", threadId: "waiting", prKey: "github/acme/widgets#3174",
      prUrl: "https://github.com/acme/widgets/pull/3174", prNumber: 3174, headSha: "abc", runAttempt: 2,
      notifyOn: ["success", "failure"], createdAt: at(15, 3), failureHandledByAutoFix: false,
    },
  },
  {
    kind: "pr_auto_fix", key: "pr_auto_fix:github/acme/widgets#3174", prKey: "github/acme/widgets#3174",
    prNumber: 3174, state: "active", durable: true, stop: "turn_off",
  },
  {
    kind: "dependency", key: "dependency:d1", durable: true, stop: "cancel", createdAt: at(14, 10),
    dependency: {
      id: "d1", mode: "all", onFailure: "notify", status: "waiting",
      continuation: "Pick up the lease changes, rebase, and confirm the tests pass.",
      conditions: [
        { backend: "codex", threadId: "lease", when: "turn_completed", title: "Sandbox lease cleanup" },
        { backend: "codex", threadId: "mcp", when: "ci_passed", title: "Remote MCP access" },
      ],
      evidence: [{
        condition: { backend: "codex", threadId: "lease", when: "turn_completed", title: "Sandbox lease cleanup" },
        state: "satisfied", reason: "Turn completed", observedAt: at(14, 31),
      }],
    },
  },
  {
    kind: "monitor", key: "monitor:m1", monitorId: "m1", task: "Staging deploy reports healthy",
    monitorBackend: "claude", model: "Haiku", pollIntervalSeconds: 120, lastActivityAt: NOW - 40_000,
    createdAt: at(14, 44), createdBy: "agent", durable: false, stop: "stop",
  },
  {
    kind: "backend_task", key: "backend_task:t1", durable: false, stop: "stop", createdBy: "agent", createdAt: NOW - 6 * 60_000,
    task: { itemId: "tool-1", processId: "t1", command: "pnpm test:desktop-e2e --shard 2/4", cwd: "/repo", background: true, startedAt: NOW - 6 * 60_000 },
  },
];

const ENDED: ThreadPendingWakeEnded[] = [
  { key: "pr_watch:old", kind: "pr_watch", endedAt: at(14, 58), summary: "PR watch woke the thread", detail: "#3174 CI failed" },
];

function controller(
  state: ThreadPendingWakesState,
  stop: (key: string) => Promise<ThreadPendingWakesResponse> = async () => ({ ok: true, stopped: true }),
  ended: (key: string) => void = () => {},
): ThreadPendingWakesController {
  return { state, stop, ended };
}

const ready = (wakes = WAKES, ended = ENDED, peer = false): ThreadPendingWakesState =>
  ({ status: "ready", wakes, ended, incomplete: false, peer });

describe("WaitingForPanel", () => {
  it("does not claim nothing can wake the thread when sources are incomplete", () => {
    render(<WaitingForPanel thread={thread} controller={controller({ status: "ready", wakes: [], ended: [], incomplete: true, peer: false })} now={NOW} />);
    expect(screen.queryByText("Nothing will wake this thread.")).not.toBeInTheDocument();
    expect(screen.getByText("Could not confirm everything this thread is waiting for.")).toBeInTheDocument();
  });

  it("groups every pending wake, soonest first, with its count", () => {
    render(<WaitingForPanel thread={thread} controller={controller(ready())} now={NOW} />);

    expect(screen.getByRole("heading", { name: "Waiting for" })).toBeInTheDocument();
    expect(screen.getByText("6")).toHaveClass("waiting-for-panel__count");
    const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Scheduled", "Pull requests", "Other threads", "Running"]);
    const prs = screen.getByRole("group", { name: "Pull requests" });
    expect(within(prs).getByText("#3174")).toBeInTheDocument();
    expect(within(prs).getByRole("button", { name: "Waiting for CI · attempt 2" })).toBeInTheDocument();
    expect(within(prs).getByText("On pass or fail. Agent, 3:03 PM.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue after 2 threads finish" })).toBeInTheDocument();
    const running = screen.getByRole("group", { name: "Running" });
    expect(within(running).getByText(/Checks every 2 min\. Last check 40s ago\./)).toBeInTheDocument();
    expect(within(running).getByText(/Claude continues when it ends\. Running 6 min\./)).toBeInTheDocument();
    // Memory-only wakes say they end with the app.
    expect(within(running).getAllByText(/Ends if PwrAgent quits\./)).toHaveLength(2);
  });

  it("stops a wake through its source and shows why a stop failed", async () => {
    const stop = vi.fn(async (key: string): Promise<ThreadPendingWakesResponse> => key === "monitor:m1"
      ? { ok: false, error: { code: "failed", message: "Sub-agent is already completing." } }
      : { ok: true, stopped: true });
    render(<WaitingForPanel thread={thread} controller={controller(ready(), stop)} now={NOW} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop: Waiting for CI · attempt 2" }));
    });
    expect(stop).toHaveBeenCalledWith("pr_watch:w1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop: Monitor: Staging deploy reports healthy" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Sub-agent is already completing.");
  });

  it("turns Auto-fix off and sends a scheduled message now through their own paths", async () => {
    const stop = vi.fn();
    const turnOff = vi.fn(async () => {});
    const sendNow = vi.fn(async () => {});
    render(
      <WaitingForPanel thread={thread} controller={controller(ready(), stop)} now={NOW}
        onTurnOffAutoFix={turnOff} onSendScheduledNow={sendNow} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn Off: Auto-fix" }));
      fireEvent.click(screen.getByRole("button", { name: "Send Now" }));
    });
    expect(turnOff).toHaveBeenCalledTimes(1);
    expect(sendNow).toHaveBeenCalledWith("a1");
    expect(stop).not.toHaveBeenCalled();
  });

  it("opens a dependency in place to show each condition and the message it sends", () => {
    const openContinueAfter = vi.fn();
    render(<WaitingForPanel thread={thread} controller={controller(ready())} now={NOW} onOpenContinueAfter={openContinueAfter} />);

    const title = screen.getByRole("button", { name: "Continue after 2 threads finish" });
    expect(title).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(title);
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Sandbox lease cleanup finishes its turn · 2:31 PM/)).toHaveClass("is-met");
    expect(screen.getByText("Remote MCP access passes CI")).not.toHaveClass("is-met");
    expect(screen.getByText(/Then the agent is told: “Pick up the lease changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in Continue After…" }));
    expect(openContinueAfter).toHaveBeenCalledTimes(1);
  });

  it("links a running task to the tab that owns it", () => {
    const showTab = vi.fn();
    render(<WaitingForPanel thread={thread} controller={controller(ready())} now={NOW} onShowTab={showTab} />);
    fireEvent.click(screen.getByRole("button", { name: "pnpm test:desktop-e2e --shard 2/4" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Actions" }));
    expect(showTab).toHaveBeenCalledWith("actions");
  });

  it("lists recently ended wakes on request", () => {
    render(<WaitingForPanel thread={thread} controller={controller(ready())} now={NOW} />);
    const toggle = screen.getByRole("button", { name: "Recently ended (1)" });
    expect(screen.queryByText("PR watch woke the thread")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("PR watch woke the thread")).toHaveTextContent("PR watch woke the thread · #3174 CI failed");
  });

  it("says nothing will wake the thread, and how to ask for a wake", () => {
    render(<WaitingForPanel thread={thread} controller={controller(ready([], []))} now={NOW} />);
    expect(screen.getByText("Nothing will wake this thread.")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows no false empty list when the owner sends none", () => {
    render(<WaitingForPanel thread={thread} controller={controller({ status: "unknown" })} ownerLabel="studio-mac" now={NOW} />);
    expect(screen.getByText("studio-mac does not share what will wake this thread.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing will wake this thread.")).not.toBeInTheDocument();
  });

  it("on a peer's thread, stops only what the owner accepts from a viewer", () => {
    const peerThread: NavigationThreadSummary = {
      ...thread,
      federation: {
        instanceId: "studio", instanceLabel: "studio-mac", capabilities: ["turn_control"],
        ref: { backend: "claude", threadId: "waiting", target: { scope: "remote", instanceId: "studio" } },
      } as NavigationThreadSummary["federation"],
    };
    render(
      <WaitingForPanel thread={peerThread} controller={controller(ready(WAKES, [], true))} ownerLabel="studio-mac" now={NOW}
        onTurnOffAutoFix={vi.fn()} onSendScheduledNow={vi.fn()} />,
    );
    // turn_control: the owner stops monitors and background tasks.
    expect(screen.getByRole("button", { name: "Stop: Monitor: Staging deploy reports healthy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop: pnpm test:desktop-e2e --shard 2/4" })).toBeInTheDocument();
    // No PR watch control, no scheduled actions, and dependencies stay local.
    expect(screen.queryByRole("button", { name: /^Stop: Waiting for CI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cancel:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Turn Off:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Now" })).not.toBeInTheDocument();
    expect(screen.getByText("Some of these run on studio-mac. Stop them there.")).toBeInTheDocument();
    expect(screen.getAllByText(/Ends if studio-mac quits\./)).toHaveLength(2);
    // A peer's history stays on the owner.
    expect(screen.queryByRole("button", { name: /Recently ended/ })).not.toBeInTheDocument();
  });

  describe("held wakes", () => {
    const LOCKED = { kind: "thread_locked" as const, note: "Parked for the release" };
    const PAUSED = { kind: "project_paused" as const, projectLabel: "widgets", directoryKey: "directory:/repo/widgets" };
    const lockHeld: ThreadPendingWake = {
      kind: "held_message", key: "held_message:thread-turn:1", entryId: "thread-turn:1", source: "operator",
      displayText: "Rebase on main.", createdAt: at(15, 30), createdBy: "operator", durable: false, stop: "discard",
      held: LOCKED,
    };
    const pauseHeld: ThreadPendingWake = {
      kind: "held_message", key: "held_message:dependency:d9", entryId: "dependency:d9", source: "dependency",
      displayText: "Continue After: Lease cleanup finished", createdAt: at(15, 40), createdBy: "agent", durable: true,
      stop: "discard", held: PAUSED,
    };

    it("says a lock holds the thread, unlocks it, and discards what it holds", async () => {
      const stop = vi.fn(async (): Promise<ThreadPendingWakesResponse> => ({ ok: true, stopped: true }));
      const unlock = vi.fn(async () => {});
      const locked: NavigationThreadSummary = {
        ...thread,
        lock: { lockedAt: at(15), note: "Parked for the release", source: "operator" },
      };
      render(
        <WaitingForPanel thread={locked} now={NOW} onUnlockThread={unlock} onSendHeldNow={vi.fn()}
          controller={controller(ready([lockHeld, { ...WAKES[1]!, held: LOCKED }], []), stop)} />,
      );

      expect(screen.getByRole("note")).toHaveTextContent("This thread is locked: Parked for the release");
      const heldGroup = screen.getByRole("group", { name: "Held" });
      expect(within(heldGroup).getByText(/Held while this thread is locked; unlocking sends it\./)).toBeInTheDocument();
      expect(within(heldGroup).getByText(/Ends if PwrAgent quits\./)).toBeInTheDocument();
      // A lock refuses a release, so only Discard and Unlock are offered.
      expect(within(heldGroup).queryByRole("button", { name: /^Send Now/ })).not.toBeInTheDocument();
      const prs = screen.getByRole("group", { name: "Pull requests" });
      expect(within(prs).getByText(/Held while this thread is locked\./)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard: Your queued message: Rebase on main." }));
      });
      expect(stop).toHaveBeenCalledWith("held_message:thread-turn:1");
      await act(async () => {
        fireEvent.click(within(screen.getByRole("note")).getByRole("button", { name: "Unlock" }));
      });
      expect(unlock).toHaveBeenCalledTimes(1);
    });

    it("sends a paused project's held wake-up through the project, and says what the pause holds", async () => {
      const sendHeld = vi.fn(async () => {});
      const ended = vi.fn();
      render(
        <WaitingForPanel thread={thread} now={NOW} onSendHeldNow={sendHeld}
          controller={controller(ready([pauseHeld, { ...WAKES[1]!, held: { ...PAUSED, discardsWakeups: true } }, { ...WAKES[3]!, held: { ...PAUSED, discardsWakeups: true } }], []), undefined, ended)} />,
      );

      expect(screen.getByRole("note")).toHaveTextContent("widgets is paused.");
      expect(screen.getByRole("note")).toHaveTextContent("Continue After results are held");
      expect(screen.getByText(/Held while widgets is paused\. Send it now, or resume the project\./)).toBeInTheDocument();
      expect(screen.getByText(/Waits while widgets is paused\./)).toBeInTheDocument();
      expect(screen.getByText(/Dropped if it ends while widgets is paused\./)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Send Now: Continue After result: Continue After: Lease cleanup finished" }));
      });
      expect(sendHeld).toHaveBeenCalledWith(pauseHeld);
      expect(ended).toHaveBeenCalledWith(pauseHeld.key);
    });

    it("discards a peer's held message with turn control, and sends it only with the project's release too", () => {
      const peerThread = (capabilities: string[]): NavigationThreadSummary => ({
        ...thread,
        federation: {
          instanceId: "studio", instanceLabel: "studio-mac", capabilities,
          ref: { backend: "claude", threadId: "waiting", target: { scope: "remote", instanceId: "studio" } },
        } as NavigationThreadSummary["federation"],
      });
      const { rerender } = render(
        <WaitingForPanel thread={peerThread([])} now={NOW} ownerLabel="studio-mac"
          controller={controller(ready([pauseHeld], [], true))} onSendHeldNow={vi.fn()} />,
      );
      expect(screen.queryByRole("button", { name: /^Discard/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Send Now/ })).not.toBeInTheDocument();
      rerender(
        <WaitingForPanel thread={peerThread(["turn_control"])} now={NOW} ownerLabel="studio-mac"
          controller={controller(ready([pauseHeld], [], true))} onSendHeldNow={vi.fn()} />,
      );
      expect(screen.getByRole("button", { name: /^Discard/ })).toBeInTheDocument();
      // Without the owner's project release, the row says how it goes instead.
      expect(screen.queryByRole("button", { name: /^Send Now/ })).not.toBeInTheDocument();
      expect(screen.getByText(/Held while widgets is paused\. Resuming the project sends it\./)).toBeInTheDocument();
      rerender(
        <WaitingForPanel thread={peerThread(["turn_control", "project_forge_automation"])} now={NOW} ownerLabel="studio-mac"
          controller={controller(ready([pauseHeld], [], true))} onSendHeldNow={vi.fn()} />,
      );
      expect(screen.getByRole("button", { name: /^Send Now/ })).toBeInTheDocument();
    });

    it("leaves out a kind this window cannot draw", () => {
      const future = { ...WAKES[0]!, kind: "something_new", key: "something_new:1" } as unknown as ThreadPendingWake;
      render(<WaitingForPanel thread={thread} now={NOW} controller={controller(ready([future, WAKES[4]!], []))} />);
      expect(screen.getByText("1")).toHaveClass("waiting-for-panel__count");
      expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Running"]);
    });
  });
});
