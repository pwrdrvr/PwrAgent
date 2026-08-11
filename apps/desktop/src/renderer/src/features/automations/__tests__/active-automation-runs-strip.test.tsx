import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationDetail,
  AutomationRunStatus,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ActiveAutomationRunsStrip } from "../ActiveAutomationRunsStrip";

const thread: NavigationThreadSummary = {
  agent: {
    name: "Search/Signals Agent",
    instructionLineCount: 0,
    instructionsTooLong: false,
    updatedAt: 1,
  },
  executionMode: "default",
  id: "thread-1",
  inbox: { inInbox: false },
  linkedDirectories: [],
  source: "codex",
  title: "Search/Signals Agent",
  titleSource: "explicit",
  updatedAt: 1,
};

function automation(
  overrides: Partial<AutomationDetail> & { id: string; name: string },
): AutomationDetail {
  return {
    backend: "codex",
    backlogPolicy: "coalesce",
    createdAt: 1,
    outputActions: [{ id: "agent-context", kind: "agent_context" }],
    scheduleSummary: "every 5 minutes",
    status: "enabled",
    taskPrompt: "Check.",
    threadId: "thread-1",
    triggers: [],
    updatedAt: 1,
    ...overrides,
  };
}

function apiWith(automations: AutomationDetail[]): DesktopApi {
  return {
    listAutomations: vi.fn(async () => ({ automations })),
    onAgentEvent: () => () => undefined,
    openAutomationRunWindow: vi.fn(async () => ({ opened: true as const })),
  } as unknown as DesktopApi;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ActiveAutomationRunsStrip", () => {
  it("stays out of the way when every run has completed", async () => {
    const { container } = render(
      <ActiveAutomationRunsStrip
        desktopApi={apiWith([
          automation({
            id: "a1",
            name: "Search Bots",
            lastRunStatus: "completed",
            lastRunAt: 1_000,
          }),
        ])}
        thread={thread}
      />,
    );

    // A finished run is history — it belongs in the rail and the Automations
    // screen, not stacked above the composer.
    await vi.waitFor(() =>
      expect(container.querySelector(".live-strip")).toBeNull(),
    );
  });

  it("reports running automations", async () => {
    render(
      <ActiveAutomationRunsStrip
        desktopApi={apiWith([
          automation({
            id: "a1",
            name: "Search Bots",
            lastRunStatus: "running",
            lastRunAt: Date.now() - 90_000,
          }),
          automation({
            id: "a2",
            name: "Nightly audit",
            lastRunStatus: "completed",
            lastRunAt: 1_000,
          }),
        ])}
        thread={thread}
      />,
    );

    expect(await screen.findByText("Search Bots")).toBeInTheDocument();
    expect(screen.getByText("Running automations")).toBeInTheDocument();
    expect(screen.queryByText("Nightly audit")).not.toBeInTheDocument();
  });

  it("keeps a failed run until it is dismissed, and can ask why", async () => {
    const desktopApi = apiWith([
      automation({
        id: "a1",
        name: "Search Bots",
        lastRunStatus: "failed" as AutomationRunStatus,
        lastRunAt: Date.now() - 60_000,
        lastRunId: "run-9",
      }),
    ]);
    render(<ActiveAutomationRunsStrip desktopApi={desktopApi} thread={thread} />);

    expect(await screen.findByText("Failed automations")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why?" }));
    expect(desktopApi.openAutomationRunWindow).toHaveBeenCalledWith(
      expect.objectContaining({ automationId: "a1", runId: "run-9" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss failed automation Search Bots" }),
    );
    expect(screen.queryByText("Failed automations")).not.toBeInTheDocument();
  });
});
