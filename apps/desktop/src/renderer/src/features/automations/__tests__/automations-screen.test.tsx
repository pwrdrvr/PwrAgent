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
import { CODEX_AGENT_THREAD_CREATION_NOTE } from "../../../lib/agent-thread";
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
    const promotableThread: NavigationThreadSummary = {
      ...ordinaryThread,
      source: "acp:gemini",
    };
    const promotedAutomation: AutomationDetail = {
      ...automation,
      backend: "acp:gemini",
      id: "automation-promoted",
      threadId: "ordinary-thread",
    };
    const createAutomation = vi.fn(async () => ({ automation: promotedAutomation }));
    const setThreadAgent = vi.fn(async () => ({
      backend: "acp:gemini" as const,
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
        threads={[thread, promotableThread]}
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
      backend: "acp:gemini",
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
        backend: "acp:gemini",
        threadId: "ordinary-thread",
      }),
    );
    expect(onRefreshNavigation).toHaveBeenCalled();
  });

  it("does not offer existing Codex threads for Agent promotion", async () => {
    const setThreadAgent = vi.fn();
    const desktopApi: DesktopApi = {
      listAutomations: vi.fn(async () => ({ automations: [] })),
      onAgentEvent: () => () => undefined,
      setThreadAgent,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread, ordinaryThread]}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Automation" }));
    const editor = screen.getByLabelText("Name").closest("form") as HTMLElement;
    fireEvent.click(within(editor).getByLabelText("Agent"));
    fireEvent.click(within(editor).getByRole("tab", { name: "Threads" }));

    expect(screen.getByText(CODEX_AGENT_THREAD_CREATION_NOTE)).toBeInTheDocument();
    expect(
      within(editor).queryByRole("option", { name: /Slack helper/ }),
    ).not.toBeInTheDocument();
    expect(setThreadAgent).not.toHaveBeenCalled();
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

    // Run history hangs off the row's disclosure chevron rather than a
    // fifth action button competing with Run/Edit.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show run history for Check email",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));

    expect(await screen.findByText("Bring an umbrella.")).toBeInTheDocument();
    expect(screen.getByText("Captured automation events")).toBeInTheDocument();
    expect(screen.getByText("Checking radar.")).toBeInTheDocument();
    expect(screen.getByText("Scheduled windows covered")).toBeInTheDocument();
    expect(screen.getByText("Ephemeral rollout")).toBeInTheDocument();
    expect(screen.getByText("It will rain at 4 PM.")).toBeInTheDocument();
  });
});

describe("row runtime and actions", () => {
  it("states the execution profile so a risky automation is spottable", async () => {
    const risky: AutomationDetail = {
      ...automation,
      executionProfile: {
        backend: "codex",
        cwd: "/Users/dev/work/payments-api",
        executionMode: "full-access",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    };
    render(
      <AutomationsScreen
        desktopApi={
          {
            listAutomations: vi.fn(async () => ({ automations: [risky] })),
            listAutomationRuns: vi.fn(async () => ({ runs: [] })),
            onAgentEvent: () => () => undefined,
          } as unknown as DesktopApi
        }
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    // Backend, model, effort, access, and directory all readable without
    // opening the editor — that is the point of the column.
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol · high")).toBeInTheDocument();
    expect(screen.getByText("Full Access")).toBeInTheDocument();
    // Shortened head-first so the repo name survives the cell width; the
    // full path stays reachable as the title.
    const cwd = screen.getByText("…/work/payments-api");
    expect(cwd).toHaveAttribute("title", "/Users/dev/work/payments-api");
  });

  it("says the runtime is inherited rather than inventing an access mode", async () => {
    render(
      <AutomationsScreen
        desktopApi={
          {
            listAutomations: vi.fn(async () => ({ automations: [automation] })),
            listAutomationRuns: vi.fn(async () => ({ runs: [] })),
            onAgentEvent: () => () => undefined,
          } as unknown as DesktopApi
        }
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("Agent default")).toBeInTheDocument();
    // An automation that overrides nothing holds no access mode, so claiming
    // "Default Access" here would state a setting it does not have.
    expect(screen.queryByText("Default Access")).not.toBeInTheDocument();
  });

  it("names the backend, model, and effort each run actually used", async () => {
    render(
      <AutomationsScreen
        desktopApi={
          {
            listAutomations: vi.fn(async () => ({ automations: [automation] })),
            listAutomationRuns: vi.fn(async () => ({
              runs: [
                {
                  ...automationRun,
                  backend: "acp:gemini",
                  usage: {
                    model: "gemini-3-pro",
                    reasoningEffort: "medium",
                    totalCostMicros: 52_000,
                  },
                },
              ],
            })),
            onAgentEvent: () => () => undefined,
          } as unknown as DesktopApi
        }
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show run history for Check email",
      }),
    );

    // Read off the run's own record, so editing the automation later cannot
    // rewrite what its history claims to have run.
    expect(await screen.findByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("gemini-3-pro · medium")).toBeInTheDocument();
    expect(screen.getByText(/\$0\.052/)).toBeInTheDocument();
  });

  it("keeps Pause and Delete behind the row overflow menu", async () => {
    render(
      <AutomationsScreen
        desktopApi={
          {
            listAutomations: vi.fn(async () => ({ automations: [automation] })),
            listAutomationRuns: vi.fn(async () => ({ runs: [] })),
            onAgentEvent: () => () => undefined,
          } as unknown as DesktopApi
        }
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    const menuButton = await screen.findByRole("button", {
      name: "More actions for Check email",
    });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(menuButton);
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("run vs replay actions", () => {
  it("offers Replay instead of Run for inbound-triggered automations", async () => {
    const inbound = {
      ...automation,
      id: "automation-2",
      triggers: [
        {
          id: "inbound-message",
          kind: "inbound_message" as const,
          conversation: { channel: "slack" as const, conversationId: "C123" },
        },
      ],
    };
    render(
      <AutomationsScreen
        desktopApi={{
          listAutomations: vi.fn(async () => ({
            automations: [automation, inbound],
          })),
          listAutomationRuns: vi.fn(async () => ({ runs: [] })),
        } as unknown as DesktopApi}
        threads={[]}
        onClose={() => undefined}
      />,
    );

    // The scheduled automation runs on demand; the inbound one has no
    // triggering message to fabricate, so it replays a captured one instead.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });
});
