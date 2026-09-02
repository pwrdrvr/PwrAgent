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

const mixedSubAgents = [
  {
    monitorId: "system:token-miser:gate-1",
    task: "Gate noisy output",
    status: "success" as const,
    createdAt: 1_800_000_000_200,
    updatedAt: 1_800_000_000_300,
  },
  {
    monitorId: "codex-native:child-1",
    task: "Inspect native worker",
    status: "running" as const,
    createdAt: 1_800_000_000_100,
    updatedAt: 1_800_000_000_100,
  },
  ...thread.subAgents!,
];

describe("SubAgentsPanel", () => {
  it("separates harness, Token Miser, and PwrAgent sub-agents", () => {
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: mixedSubAgents,
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: "Harness 1" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Inspect native worker")).toBeInTheDocument();
    expect(screen.queryByText("Gate noisy output")).not.toBeInTheDocument();
    expect(screen.queryByText("Watch the deployment")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Token Miser 1" }));
    expect(screen.getByText("Gate noisy output")).toBeInTheDocument();
    expect(screen.queryByText("Inspect native worker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "PwrAgent 2" }));
    expect(screen.getByText("Watch the deployment")).toBeInTheDocument();
    expect(screen.getByText("Finished work")).toBeInTheDocument();
    expect(screen.queryByText("Gate noisy output")).not.toBeInTheDocument();
  });

  it("uses roving focus and horizontal tablist keyboard navigation", () => {
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: mixedSubAgents,
        }}
      />,
    );

    const tablist = screen.getByRole("tablist", {
      name: "Sub-agent ownership",
    });
    const harness = screen.getByRole("tab", { name: "Harness 1" });
    const tokenMiser = screen.getByRole("tab", { name: "Token Miser 1" });
    const pwrAgent = screen.getByRole("tab", { name: "PwrAgent 2" });

    expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
    expect(harness).toHaveAttribute("tabindex", "0");
    expect(tokenMiser).toHaveAttribute("tabindex", "-1");
    expect(pwrAgent).toHaveAttribute("tabindex", "-1");

    harness.focus();
    fireEvent.keyDown(harness, { key: "ArrowRight" });
    expect(tokenMiser).toHaveFocus();
    expect(harness).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(tokenMiser, { key: "End" });
    expect(pwrAgent).toHaveFocus();
    fireEvent.keyDown(pwrAgent, { key: "ArrowRight" });
    expect(harness).toHaveFocus();
    fireEvent.keyDown(harness, { key: "ArrowLeft" });
    expect(pwrAgent).toHaveFocus();
    fireEvent.keyDown(pwrAgent, { key: "Home" });
    expect(harness).toHaveFocus();
  });

  it("uses unique tab relationships for each mounted panel", () => {
    render(
      <>
        <SubAgentsPanel
          thread={{ ...thread, subAgents: mixedSubAgents }}
        />
        <SubAgentsPanel
          thread={{ ...thread, id: "second-thread", subAgents: mixedSubAgents }}
        />
      </>,
    );

    const tablists = screen.getAllByRole("tablist", {
      name: "Sub-agent ownership",
    });
    const firstHarness = within(tablists[0]!).getByRole("tab", {
      name: "Harness 1",
    });
    const secondHarness = within(tablists[1]!).getByRole("tab", {
      name: "Harness 1",
    });
    const panels = screen.getAllByRole("tabpanel");

    expect(firstHarness.id).not.toBe(secondHarness.id);
    expect(panels[0]!.id).not.toBe(panels[1]!.id);
    expect(firstHarness).toHaveAttribute("aria-controls", panels[0]!.id);
    expect(secondHarness).toHaveAttribute("aria-controls", panels[1]!.id);
    expect(panels[0]).toHaveAttribute("aria-labelledby", firstHarness.id);
    expect(panels[1]).toHaveAttribute("aria-labelledby", secondHarness.id);
  });

  it("prefers PwrAgent when a thread has no harness-managed sub-agents", () => {
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: [
            {
              monitorId: "system:token-miser:gate-1",
              task: "Gate noisy output",
              status: "success",
              createdAt: 1_800_000_000_200,
              updatedAt: 1_800_000_000_300,
            },
            ...thread.subAgents!,
          ],
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: "PwrAgent 2" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Watch the deployment")).toBeInTheDocument();
    expect(screen.queryByText("Gate noisy output")).not.toBeInTheDocument();
  });

  it("limits completed native workers while preserving current and managed monitors", () => {
    const now = Date.now();
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: [
            {
              monitorId: "codex-native:stale-worker",
              task: "Stale native worker",
              status: "success",
              createdAt: now - (2 * 24 * 60 * 60 * 1000),
              updatedAt: now - (2 * 24 * 60 * 60 * 1000),
              completedAt: now - (2 * 24 * 60 * 60 * 1000),
            },
            {
              monitorId: "codex-native:active-worker",
              task: "Active native worker",
              status: "running",
              createdAt: 1,
              updatedAt: 1,
            },
            {
              monitorId: "monitor:managed-history",
              task: "Managed monitor history",
              status: "success",
              createdAt: 1,
              updatedAt: 1,
              completedAt: 1,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Stale native worker")).not.toBeInTheDocument();
    expect(screen.getByText("Active native worker")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "PwrAgent 1" }));
    expect(screen.getByText("Managed monitor history")).toBeInTheDocument();
  });

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

  it("identifies a policy pass-through that did not invoke Luna", () => {
    render(
      <SubAgentsPanel
        thread={{
          ...thread,
          subAgents: [{
            monitorId: "system:token-miser:policy-1",
            task: "Evaluate Code Mode output",
            status: "success",
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_100,
            backend: "codex",
            agentName: "Token Miser",
            tokenMiserAccounting: {
              currency: "USD",
              decisionSource: "policy",
              disposition: "passed_through",
              originalModel: "gpt-5.6-sol",
              baselineParentTokens: 1_000,
              baselineParentCostMicros: 2_500,
              cachedReplayCount: 0,
              cachedBaselineTokens: 0,
              cachedBaselineCostMicros: 0,
              gateModel: "policy",
              gateTotalTokens: 0,
              gateCostMicros: 0,
              revealedParentTokens: 1_000,
              revealedParentCostMicros: 2_500,
              cachedRevealedTokens: 0,
              cachedRevealedCostMicros: 0,
              savingsMicros: 0,
            },
          }],
        }}
      />,
    );

    const savings = screen.getByLabelText("Token Miser savings");
    expect(within(savings).getByText("2 · Policy evaluation")).toBeInTheDocument();
    expect(savings).toHaveTextContent("No helper model invoked");
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
