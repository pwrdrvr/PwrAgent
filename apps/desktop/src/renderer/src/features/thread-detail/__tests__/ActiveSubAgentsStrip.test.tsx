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

    it("names its controls after their sub-agent instead of claiming bare Stop/Dismiss", () => {
      // Regression: a bare "Stop" shadowed the composer's stop-the-turn button
      // and broke nine E2E specs that use page-wide `name: "Stop"` as its
      // handle (managed-review.spec.ts caught it). It is also the a11y fix — a
      // column of identically-named buttons tells a screen-reader user nothing
      // about which sub-agent each one belongs to.
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
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
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
