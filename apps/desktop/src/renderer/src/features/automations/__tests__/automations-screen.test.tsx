import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationDetail,
  AutomationRunSummary,
  GetAutomationRunArtifactResponse,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AutomationsScreen } from "../AutomationsScreen";

const thread: NavigationThreadSummary = {
  agent: {
    name: "Email Agent",
    instructionLineCount: 0,
    instructionsTooLong: false,
    updatedAt: 1,
  },
  executionMode: "default",
  id: "thread-1",
  inbox: { inInbox: false },
  linkedDirectories: [],
  source: "codex",
  title: "Email triage",
  titleSource: "explicit",
  updatedAt: 1,
};

const ordinaryThread: NavigationThreadSummary = {
  executionMode: "default",
  id: "ordinary-thread",
  inbox: { inInbox: false },
  linkedDirectories: [],
  source: "codex",
  title: "Slack helper",
  titleSource: "explicit",
  updatedAt: 2,
};

const automation: AutomationDetail = {
  backend: "codex",
  backlogPolicy: "coalesce",
  createdAt: 1,
  id: "automation-1",
  name: "Check email",
  schedule: {
    every: 5,
    kind: "interval",
    unit: "minutes",
  },
  scheduleSummary: "every 5 minutes",
  status: "enabled",
  taskPrompt: "Check email.",
  threadId: "thread-1",
  triggers: [
    {
      id: "schedule",
      kind: "schedule",
      schedule: {
        every: 5,
        kind: "interval",
        unit: "minutes",
      },
    },
  ],
  outputActions: [{ id: "agent-context", kind: "agent_context" }],
  updatedAt: 1,
};

const automationRun: AutomationRunSummary = {
  automationId: "automation-1",
  backendThreadId: "headless-thread-1",
  backendTurnId: "turn-1",
  completedAt: 1_000,
  id: "run-1",
  scheduledFor: 1_000,
  scheduledWindows: [{ scheduledFor: 1_000 }, { scheduledFor: 2_000 }],
  status: "completed",
  trigger: "scheduled",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AutomationsScreen", () => {
  it("lists automations without adding a thread lens and navigates to the assigned Agent", async () => {
    const onSelectThread = vi.fn();
    const desktopApi: DesktopApi = {
      listAutomations: vi.fn(async () => ({ automations: [automation] })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      onAgentEvent: () => () => undefined,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread]}
        onClose={() => undefined}
        onSelectThread={onSelectThread}
      />,
    );

    expect(await screen.findByText("Check email")).toBeInTheDocument();
    expect(screen.getByText("every 5 minutes")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Thread lenses" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Email Agent" }));

    expect(onSelectThread).toHaveBeenCalledWith(thread);
  });

  it("creates an automation with an assigned Agent from the global editor", async () => {
    const createAutomation = vi.fn(async () => ({ automation }));
    const desktopApi: DesktopApi = {
      createAutomation,
      listAutomations: vi
        .fn()
        .mockResolvedValueOnce({ automations: [] })
        .mockResolvedValue({ automations: [automation] }),
      onAgentEvent: () => () => undefined,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Automation" }));
    const editor = screen.getByLabelText("Name").closest("form") as HTMLElement;
    expect(editor).not.toBeNull();
    fireEvent.change(within(editor).getByLabelText("Name"), {
      target: { value: "Check email" },
    });
    fireEvent.click(within(editor).getByLabelText("Agent"));
    fireEvent.click(within(editor).getByRole("option", { name: /Email Agent/ }));
    fireEvent.change(within(editor).getByLabelText("Task prompt"), {
      target: { value: "Check email." },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    expect(createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        backlogPolicy: "coalesce",
        threadId: "thread-1",
      }),
    );
  });

  it("promotes a regular thread to an Agent before creating an automation", async () => {
    const promotedAutomation: AutomationDetail = {
      ...automation,
      id: "automation-promoted",
      threadId: "ordinary-thread",
    };
    const createAutomation = vi.fn(async () => ({ automation: promotedAutomation }));
    const setThreadAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
      agent: {
        name: "Slack Agent",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 3,
      },
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      createAutomation,
      listAutomations: vi
        .fn()
        .mockResolvedValueOnce({ automations: [] })
        .mockResolvedValue({ automations: [promotedAutomation] }),
      onAgentEvent: () => () => undefined,
      setThreadAgent,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread, ordinaryThread]}
        onClose={() => undefined}
        onRefreshNavigation={onRefreshNavigation}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Automation" }));
    const editor = screen.getByLabelText("Name").closest("form") as HTMLElement;
    expect(editor).not.toBeNull();
    fireEvent.change(within(editor).getByLabelText("Name"), {
      target: { value: "Slack automation" },
    });
    fireEvent.click(within(editor).getByLabelText("Agent"));
    fireEvent.click(within(editor).getByRole("tab", { name: "Threads" }));
    fireEvent.click(within(editor).getByRole("option", { name: /Slack helper/ }));

    await waitFor(() => expect(setThreadAgent).toHaveBeenCalledTimes(1));
    expect(setThreadAgent).toHaveBeenCalledWith({
      agent: { name: "Slack helper" },
      backend: "codex",
      threadId: "ordinary-thread",
    });
    expect(within(editor).getByLabelText("Agent")).toHaveTextContent("Slack Agent");

    fireEvent.change(within(editor).getByLabelText("Task prompt"), {
      target: { value: "Post the latest automation state." },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    expect(createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "ordinary-thread",
      }),
    );
    expect(onRefreshNavigation).toHaveBeenCalled();
  });

  it("shows rollout replay details for an automation run", async () => {
    const artifactResponse: GetAutomationRunArtifactResponse = {
      artifact: {
        actionResults: [],
        automationId: "automation-1",
        createdAt: 1_000,
        finalText: "Bring an umbrella.",
        runId: "run-1",
        status: "completed",
        transcriptEvents: [
          {
            at: 1_000,
            id: "run-1:assistant:progress",
            kind: "assistant_final",
            text: "Checking radar.",
          },
        ],
        updatedAt: 1_000,
      },
      rollout: {
        backend: "codex",
        replay: {
          entries: [
            {
              id: "rollout-user",
              role: "user",
              text: "Automation prompt",
              type: "message",
            },
            {
              id: "rollout-assistant",
              phase: "final",
              role: "assistant",
              text: "It will rain at 4 PM.",
              type: "message",
            },
          ],
          messages: [],
          pagination: {
            hasPreviousPage: false,
            supportsPagination: false,
          },
        },
        threadId: "headless-thread-1",
        turnId: "turn-1",
      },
    };
    const desktopApi: DesktopApi = {
      getAutomationRunArtifact: vi.fn(async () => artifactResponse),
      listAutomationRuns: vi.fn(async () => ({ runs: [automationRun] })),
      listAutomations: vi.fn(async () => ({ automations: [automation] })),
      onAgentEvent: () => () => undefined,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));

    expect(await screen.findByText("Bring an umbrella.")).toBeInTheDocument();
    expect(screen.getByText("Captured automation events")).toBeInTheDocument();
    expect(screen.getByText("Checking radar.")).toBeInTheDocument();
    expect(screen.getByText("Scheduled windows covered")).toBeInTheDocument();
    expect(screen.getByText("Ephemeral rollout")).toBeInTheDocument();
    expect(screen.getByText("It will rain at 4 PM.")).toBeInTheDocument();
  });
});
