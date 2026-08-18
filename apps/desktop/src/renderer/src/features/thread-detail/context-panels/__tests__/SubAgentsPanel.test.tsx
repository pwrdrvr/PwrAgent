import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../../lib/desktop-api";
import { SubAgentsPanel } from "../SubAgentsPanel";

afterEach(() => {
  cleanup();
});

const thread: NavigationThreadSummary = {
  id: "parent-thread",
  title: "Parent thread",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: true },
  subAgents: [
    {
      monitorId: "monitor-1",
      task: "Watch the deployment",
      status: "running",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      backend: "codex",
      monitorThreadId: "monitor-thread",
      monitorTurnId: "monitor-turn",
    },
    {
      monitorId: "monitor-2",
      task: "Finished work",
      status: "success",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      completedAt: 1_700_000_000_100,
      backend: "codex",
      monitorThreadId: "finished-thread",
      monitorTurnId: "finished-turn",
    },
  ],
};

describe("SubAgentsPanel", () => {
  it("shows Token Miser's per-gate cost equation", () => {
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: [{
            monitorId: "system:token-miser:gate-1",
            task: "Gate Bash output",
            status: "success",
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_100,
            backend: "codex",
            agentName: "Token Miser",
            tokenMiserAccounting: {
              currency: "USD",
              originalModel: "gpt-5.6-terra",
              baselineParentTokens: 6_000,
              baselineParentCostMicros: 15_000,
              cachedReplayCount: 6,
              cachedBaselineTokens: 36_000,
              cachedBaselineCostMicros: 9_000,
              gateModel: "gpt-5.6-luna",
              gateTotalTokens: 2_100,
              gateCostMicros: 2_600,
              revealedParentTokens: 225,
              revealedParentCostMicros: 563,
              cachedRevealedTokens: 1_350,
              cachedRevealedCostMicros: 338,
              savingsMicros: 20_499,
            },
          }],
        }}
      />,
    );

    const savings = screen.getByLabelText("Token Miser savings");
    expect(within(savings).getByText("1 · Without gate")).toBeInTheDocument();
    expect(savings).toHaveTextContent("$0.024");
    expect(savings).toHaveTextContent(
      "6,000 uncached + 36,000 cached across 6 replays · gpt-5.6-terra",
    );
    expect(within(savings).getByText("2 · Gate model")).toBeInTheDocument();
    expect(savings).toHaveTextContent("2,100 total · gpt-5.6-luna");
    expect(within(savings).getByText("3 · Revealed to parent")).toBeInTheDocument();
    expect(savings).toHaveTextContent(
      "225 uncached + 1,350 cached · gpt-5.6-terra",
    );
    expect(within(savings).getByText("Savings · 1 − 2 − 3"))
      .toBeInTheDocument();
    expect(savings).toHaveTextContent("$0.021");
  });

  it("stops a running sub-agent and refreshes navigation", async () => {
    const stopSubAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "parent-thread",
      monitorId: "monitor-1",
      stoppedAt: 1_800_000_000_100,
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);

    render(
      <SubAgentsPanel
        desktopApi={{ stopSubAgent } as DesktopApi}
        onRefreshNavigation={onRefreshNavigation}
        thread={thread}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(stopSubAgent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "parent-thread",
        monitorId: "monitor-1",
      });
    });
    expect(onRefreshNavigation).toHaveBeenCalledTimes(1);
  });

  it("offers Stop while a monitor reports pending external work", () => {
    const activeSubAgent = thread.subAgents?.[0];
    expect(activeSubAgent).toBeDefined();

    render(
      <SubAgentsPanel
        desktopApi={{ stopSubAgent: vi.fn() } as unknown as DesktopApi}
        thread={{
          ...thread,
          subAgents: [
            {
              ...activeSubAgent!,
              status: "pending",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("keeps the control available and reports an interruption failure", async () => {
    const stopSubAgent = vi.fn(async () => {
      throw new Error("Sub-agent is no longer running.");
    });

    render(
      <SubAgentsPanel
        desktopApi={{ stopSubAgent } as DesktopApi}
        thread={thread}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Sub-agent is no longer running.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("allows an active blocked monitor to be stopped", async () => {
    const activeSubAgent = thread.subAgents?.[0];
    expect(activeSubAgent).toBeDefined();
    const stopSubAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "parent-thread",
      monitorId: "monitor-1",
      stoppedAt: 1_800_000_000_100,
    }));

    render(
      <SubAgentsPanel
        desktopApi={{ stopSubAgent } as DesktopApi}
        thread={{
          ...thread,
          subAgents: [
            {
              ...activeSubAgent!,
              status: "blocked",
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(stopSubAgent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "parent-thread",
        monitorId: "monitor-1",
      });
    });
  });

  it("keeps an open details dialog on the live sub-agent record", () => {
    const { rerender } = render(<SubAgentsPanel thread={thread} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.getByRole("dialog")).toHaveTextContent("Running");

    rerender(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: thread.subAgents!.map((subAgent) =>
            subAgent.monitorId === "monitor-1"
              ? { ...subAgent, status: "success" as const }
              : subAgent,
          ),
        }}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Completed");
  });

  it("targets the owning instance when stopping a remote sub-agent", async () => {
    const stopSubAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "parent-thread",
      monitorId: "monitor-1",
      stoppedAt: 1_800_000_000_100,
    }));
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner_one",
    };

    render(
      <SubAgentsPanel
        desktopApi={{ stopSubAgent } as DesktopApi}
        thread={{
          ...thread,
          federation: {
            instanceLabel: "Owner One",
            ref: {
              target: federationTarget,
              backend: "codex",
              threadId: "parent-thread",
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(stopSubAgent).toHaveBeenCalledWith({
        backend: "codex",
        federationTarget,
        threadId: "parent-thread",
        monitorId: "monitor-1",
      });
    });
  });
});
