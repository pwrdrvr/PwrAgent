import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
