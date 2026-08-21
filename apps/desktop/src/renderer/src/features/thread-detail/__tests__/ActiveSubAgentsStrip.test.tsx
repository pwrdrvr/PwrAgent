import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ActiveSubAgentsStrip } from "../ActiveSubAgentsStrip";

afterEach(() => {
  cleanup();
});

function buildSubAgent(
  overrides: Partial<ThreadSubAgentSummary> = {},
): ThreadSubAgentSummary {
  return {
    monitorId: overrides.monitorId ?? "monitor-1",
    task: overrides.task ?? "Watch the deployment",
    status: overrides.status ?? "running",
    createdAt: overrides.createdAt ?? 1_800_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_800_000_000_000,
    backend: overrides.backend ?? "codex",
    monitorThreadId: overrides.monitorThreadId ?? "monitor-thread",
    monitorTurnId: overrides.monitorTurnId ?? "monitor-turn",
    ...overrides,
  };
}

function buildThread(
  subAgents: ThreadSubAgentSummary[],
): NavigationThreadSummary {
  return {
    id: "parent-thread",
    title: "Parent thread",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: true },
    subAgents,
  } as NavigationThreadSummary;
}

describe("ActiveSubAgentsStrip", () => {
  describe("presence", () => {
    it("renders nothing when the thread has no sub-agents", () => {
      const { container } = render(
        <ActiveSubAgentsStrip thread={buildThread([])} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("counts on the app's shared mark-and-number, not a pill of its own", () => {
      // This strip drew its count inside a bordered 18px pill with the
      // scanner parked after it, so the same statement the sidebar makes
      // two panes away ("this many, working") looked like a different kind
      // of object in one window. See `SignalCount.tsx`.
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([buildSubAgent({ monitorId: "running-1" })])}
        />,
      );

      const count = container.querySelector(".live-strip__count")!;
      expect(count).toHaveClass("signal-count");
      expect(count).toHaveClass("signal-count--active");
      // Mark first, digits last — the order every other surface uses.
      expect(count.firstElementChild).toHaveClass("thinking-scanner");
      expect(count.lastElementChild).toHaveClass("signal-count__value");
      expect(count.lastElementChild).toHaveTextContent("1");
    });

    it("keeps the tone with the heading when only blocked rows are left", () => {
      // The two halves of the readout answer different questions: the mark
      // says whether anything is progressing (nothing is), the tone says
      // what the number counts. A blocked sub-agent is still an ACTIVE one —
      // `activeCount` includes it and the heading says so — so painting the
      // count in the idle grey would have the strip contradict its own label.
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "blocked-1", status: "blocked" }),
          ])}
        />,
      );

      expect(screen.getByText("Active sub-agents")).toBeInTheDocument();
      const count = container.querySelector(".live-strip__count")!;
      expect(count).toHaveClass("signal-count--active");
      expect(count).not.toHaveClass("signal-count--idle");
      // Blocked is not progressing, so the beam still must not sweep.
      expect(count.querySelector(".thinking-scanner")).toBeNull();
      expect(count.firstElementChild).toHaveClass(
        "signal-count__dormant-scanner",
      );
    });

    it("swaps the sweep for the dormant bar when nothing is running", () => {
      // A failure you have not dismissed still holds the strip open, but
      // nothing is progressing — and the count keeps its full weight,
      // because an undismissed failure is something to act on.
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "failed-1", status: "failed" }),
          ])}
        />,
      );

      const count = container.querySelector(".live-strip__count")!;
      expect(count).toHaveClass("signal-count--idle");
      expect(count.querySelector(".thinking-scanner")).toBeNull();
      expect(count.firstElementChild).toHaveClass(
        "signal-count__dormant-scanner",
      );
      expect(count).not.toHaveAttribute("data-zero");
    });

    it("renders nothing when every sub-agent has finished", () => {
      // Successful and cancelled sub-agents leave immediately — the sidebar
      // and the rail panel already hold them.
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({
              monitorId: "done",
              status: "success",
              completedAt: 1_800_000_001_000,
            }),
            buildSubAgent({
              monitorId: "gone",
              status: "cancelled",
              completedAt: 1_800_000_001_000,
            }),
          ])}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when the thread itself is undefined", () => {
      const { container } = render(<ActiveSubAgentsStrip />);
      expect(container).toBeEmptyDOMElement();
    });

    it("counts what the heading claims, not the row total", () => {
      // Regression: the count was `visible.length` while the heading only
      // flipped when nothing ran, so one live monitor beside a dozen old
      // failures read "Active sub-agents 13".
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "live" }),
            ...Array.from({ length: 12 }, (_unused, index) =>
              buildSubAgent({ monitorId: `dead-${index}`, status: "failed" }),
            ),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: "Active sub-agents (1), 12 failed",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("12 failed")).toBeInTheDocument();
      expect(screen.queryByText("13")).toBeNull();
    });

    it("counts only the rows it shows, ignoring finished sub-agents", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a" }),
            buildSubAgent({ monitorId: "b" }),
            buildSubAgent({
              monitorId: "done",
              status: "success",
              completedAt: 1_800_000_001_000,
            }),
          ])}
        />,
      );
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  describe("disclosure", () => {
    it("seeds expanded at one or two active sub-agents", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", task: "First task" }),
            buildSubAgent({ monitorId: "b", task: "Second task" }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("First task")).toBeInTheDocument();
    });

    it("seeds collapsed at three or more, hiding the rows", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", task: "First task" }),
            buildSubAgent({ monitorId: "b", task: "Second task" }),
            buildSubAgent({ monitorId: "c", task: "Third task" }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("First task")).toBeNull();
      // The count still reports what is running while collapsed.
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("seeds from the first render that has rows, not from an empty mount", () => {
      // Regression: the Composer mounts this component unconditionally and it
      // returns null while empty, so a mount-time seed always measured zero
      // rows and pinned expanded=true forever. Every earlier test rendered
      // straight into a populated state, which the app never does — so the
      // collapse-at-3+ rule passed its tests and never once fired in the app.
      const { rerender } = render(<ActiveSubAgentsStrip thread={buildThread([])} />);
      rerender(
        <ActiveSubAgentsStrip
          thread={buildThread(
            Array.from({ length: 5 }, (_unused, index) =>
              buildSubAgent({ monitorId: `monitor-${index}` }),
            ),
          )}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "false");
    });

    it("re-seeds for the next batch after the strip empties", () => {
      // Seeding once per window would let a session's first batch govern every
      // later one — a single early sub-agent would leave the strip expanded for
      // a batch of nine hours later.
      const { rerender } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([buildSubAgent({ monitorId: "solo" })])}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "true");

      rerender(<ActiveSubAgentsStrip thread={buildThread([])} />);
      rerender(
        <ActiveSubAgentsStrip
          thread={buildThread(
            Array.from({ length: 4 }, (_unused, index) =>
              buildSubAgent({ monitorId: `next-${index}` }),
            ),
          )}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps a manual collapse when the active count later changes", () => {
      // The seed is a mount-time convenience, not a live rule: re-evaluating
      // it would yank the disclosure out from under an operator who already
      // made a choice.
      const { rerender } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([buildSubAgent({ monitorId: "a" })])}
        />,
      );
      const toggle = screen.getByRole("button", { name: /Active sub-agents/ });
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      rerender(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a" }),
            buildSubAgent({ monitorId: "b" }),
            buildSubAgent({ monitorId: "c" }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", { name: /Active sub-agents/ }),
      ).toHaveAttribute("aria-expanded", "false");
    });

    it("renders every active row so the capped list scrolls rather than truncating", () => {
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread(
            Array.from({ length: 6 }, (_unused, index) =>
              buildSubAgent({
                monitorId: `monitor-${index}`,
                task: `Task ${index}`,
              }),
            ),
          )}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Active sub-agents/ }));
      // The four-row cap is a max-height on .live-strip__list, so all six rows
      // must exist in the DOM — a silently truncated list would read as
      // "that's everything" when it isn't.
      expect(container.querySelectorAll(".live-strip__item")).toHaveLength(6);
    });
  });

  describe("failed sub-agents", () => {
    it("does not call itself Active when nothing is running", () => {
      // Regression: a thread with 13 failures and nothing running rendered
      // "ACTIVE SUB-AGENTS 13", which is just false.
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "failed" }),
            buildSubAgent({ monitorId: "b", status: "failed" }),
          ])}
        />,
      );
      expect(screen.getByText("Failed sub-agents")).toBeInTheDocument();
      expect(screen.queryByText("Active sub-agents")).toBeNull();
    });

    it("calls itself Active again as soon as anything is running", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "failed" }),
            buildSubAgent({ monitorId: "b" }),
          ])}
        />,
      );
      expect(screen.getByText("Active sub-agents")).toBeInTheDocument();
    });

    it("keeps a failed sub-agent visible and states the outcome in words", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({
              monitorId: "broken",
              status: "failed",
              task: "Broken monitor",
            }),
          ])}
        />,
      );
      expect(screen.getByText("Broken monitor")).toBeInTheDocument();
      // Never color alone.
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    it("treats the 'failure' spelling the same as 'failed'", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({
              monitorId: "broken",
              status: "failure",
              task: "Other spelling",
            }),
          ])}
        />,
      );
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    it("does not blink or offer Stop for a failed row", () => {
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "broken", status: "failed" }),
          ])}
        />,
      );
      // A finished failure must not animate.
      expect(container.querySelector(".status-dot--blink")).toBeNull();
      expect(container.querySelector(".thinking-scanner")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Stop sub-agent:/ })).toBeNull();
    });

    it("offers a bulk dismiss once more than one failure is showing", () => {
      const { container, rerender } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "failed" }),
          ])}
        />,
      );
      // One failure is not a chore; the control would just be noise.
      expect(screen.queryByRole("button", { name: /^Dismiss all/ })).toBeNull();

      rerender(
        <ActiveSubAgentsStrip
          thread={buildThread(
            Array.from({ length: 13 }, (_unused, index) =>
              buildSubAgent({
                monitorId: `monitor-${index}`,
                status: "failed",
                task: `Failed task ${index}`,
              }),
            ),
          )}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss all 13 failed sub-agents" }),
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("never sweeps up a running sub-agent in the bulk dismiss", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "run", task: "Still going" }),
            buildSubAgent({ monitorId: "x", status: "failed" }),
            buildSubAgent({ monitorId: "y", status: "failed" }),
          ])}
        />,
      );
      // Three rows seeds collapsed, so expand before reading the list.
      fireEvent.click(screen.getByRole("button", { name: /Active sub-agents/ }));
      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss all 2 failed sub-agents" }),
      );
      expect(screen.getByText("Still going")).toBeInTheDocument();
      expect(screen.queryByText("Failed")).toBeNull();
    });

    it("removes a failed row once dismissed, and the strip with it", () => {
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "broken", status: "failed" }),
          ])}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Dismiss failed sub-agent:/ }));
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("blocked sub-agents", () => {
    it("shows a blocked row without a blinking dot or a running clock", () => {
      // A blocked sub-agent is waiting on input, not working. Blinking an
      // accent dot and counting up an elapsed timer says the opposite.
      const { container } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "blocked" }),
          ])}
        />,
      );
      expect(screen.getByText("Blocked")).toBeInTheDocument();
      expect(container.querySelector(".status-dot--warning")).not.toBeNull();
      expect(container.querySelector(".status-dot--blink")).toBeNull();
      // Nothing is progressing, so nothing sweeps.
      expect(container.querySelector(".thinking-scanner")).toBeNull();
    });

    it("still counts blocked sub-agents as active", () => {
      render(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "blocked" }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Active sub-agents (1)" }),
      ).toBeInTheDocument();
    });

    it("allows a blocked monitor with an active turn to be stopped", async () => {
      const stopSubAgent = vi.fn().mockResolvedValue({ ok: true });
      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent } as unknown as DesktopApi}
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "blocked" }),
          ])}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^Stop sub-agent:/ }));
      await waitFor(() => {
        expect(stopSubAgent).toHaveBeenCalledWith({
          backend: "codex",
          threadId: "parent-thread",
          monitorId: "a",
        });
      });
    });
  });

  describe("liveness", () => {
    it("shows the shared thinking scanner only while something is running", () => {
      const { container, rerender } = render(
        <ActiveSubAgentsStrip
          thread={buildThread([buildSubAgent({ monitorId: "a" })])}
        />,
      );
      expect(container.querySelector(".thinking-scanner")).not.toBeNull();
      expect(
        container.querySelector(".status-dot--active.status-dot--blink"),
      ).not.toBeNull();

      rerender(
        <ActiveSubAgentsStrip
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "failed" }),
          ])}
        />,
      );
      expect(container.querySelector(".thinking-scanner")).toBeNull();
    });

    it("ticks at most once per second, and only while something runs", () => {
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      try {
        const { unmount } = render(
          <ActiveSubAgentsStrip
            thread={buildThread([buildSubAgent({ monitorId: "a" })])}
          />,
        );
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
        unmount();
        setIntervalSpy.mockClear();

        render(
          <ActiveSubAgentsStrip
            thread={buildThread([
              buildSubAgent({ monitorId: "a", status: "failed" }),
            ])}
          />,
        );
        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        setIntervalSpy.mockRestore();
      }
    });
  });

  describe("stop interaction", () => {
    it("routes Stop through desktopApi with the thread's backend and federation target", async () => {
      const stopSubAgent = vi.fn().mockResolvedValue({ ok: true });
      const onRefreshNavigation = vi.fn().mockResolvedValue(undefined);
      const federationTarget = {
        scope: "remote",
        instanceId: "peer-instance",
      } as const;
      const thread: NavigationThreadSummary = {
        ...buildThread([buildSubAgent({ monitorId: "monitor-1" })]),
        federation: {
          ref: {
            backend: "codex",
            target: federationTarget,
            threadId: "remote-thread",
          },
          instanceLabel: "Peer",
        },
      };

      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent } as unknown as DesktopApi}
          onRefreshNavigation={onRefreshNavigation}
          thread={thread}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^Stop sub-agent:/ }));
      await waitFor(() => {
        expect(stopSubAgent).toHaveBeenCalledWith({
          backend: "codex",
          federationTarget,
          threadId: "parent-thread",
          monitorId: "monitor-1",
        });
      });
      await waitFor(() => {
        expect(onRefreshNavigation).toHaveBeenCalled();
      });
    });

    it("names its controls after the sub-agent they act on", () => {
      // A column of buttons all named "Stop" tells a screen-reader user
      // nothing about which sub-agent each one belongs to.
      //
      // This does NOT protect the composer's stop-the-turn button from a
      // page-wide locator, and an earlier version of this test claimed it did.
      // Testing Library matches a string `name` exactly, so "Stop" not
      // matching "Stop sub-agent: …" here proves nothing about Playwright,
      // which matches `name` as a normalized SUBSTRING by default — the E2E
      // collision survived this exact assertion. The composer button carries
      // data-testid="composer-stop-turn" and the specs target that instead.
      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent: vi.fn() } as unknown as DesktopApi}
          thread={buildThread([
            buildSubAgent({ monitorId: "a", task: "Watch the deployment" }),
            buildSubAgent({
              monitorId: "b",
              status: "failed",
              task: "Broken monitor",
            }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: "Stop sub-agent: Watch the deployment",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "Dismiss failed sub-agent: Broken monitor",
        }),
      ).toBeInTheDocument();
    });

    it("offers no Stop when the sub-agent has no monitor turn to stop", () => {
      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent: vi.fn() } as unknown as DesktopApi}
          thread={buildThread([
            buildSubAgent({ monitorId: "a", monitorTurnId: undefined }),
          ])}
        />,
      );
      expect(screen.queryByRole("button", { name: /^Stop sub-agent:/ })).toBeNull();
    });

    it("offers Stop while a monitor reports pending external work", () => {
      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent: vi.fn() } as unknown as DesktopApi}
          thread={buildThread([
            buildSubAgent({ monitorId: "a", status: "pending" }),
          ])}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: "Stop sub-agent: Watch the deployment",
        }),
      ).toBeInTheDocument();
    });

    it("recovers the button after a failed stop instead of leaving it stuck", async () => {
      const stopSubAgent = vi.fn().mockRejectedValue(new Error("nope"));
      render(
        <ActiveSubAgentsStrip
          desktopApi={{ stopSubAgent } as unknown as DesktopApi}
          thread={buildThread([buildSubAgent({ monitorId: "a" })])}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Stop sub-agent:/ }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^Stop sub-agent:/ })).toBeEnabled();
      });
    });
  });
});
