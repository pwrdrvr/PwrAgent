import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendKind,
  AutomationDetail,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { AutomationEditor } from "../AutomationEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AutomationEditor", () => {
  it("submits a coalescing interval automation for the assigned Agent", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Check email" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Check email and summarize anything urgent." },
    });
    fireEvent.change(screen.getByLabelText("Every"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: {
        backend: "codex",
        backlogPolicy: "coalesce",
        enabled: true,
        executionProfile: undefined,
        gate: undefined,
        name: "Check email",
        outputActions: [{ id: "agent-context", kind: "agent_context" }],
        schedule: {
          every: 5,
          kind: "interval",
          unit: "minutes",
        },
        taskPrompt: "Check email and summarize anything urgent.",
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
      },
    });
  });

  it("submits an inbound Slack trigger with execution overrides and source reply output", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Investigate Datadog" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate the alert and summarize likely causes." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.change(screen.getByLabelText("Conversation ID"), {
      target: { value: "C123" },
    });
    fireEvent.change(screen.getByLabelText("Sender ID"), {
      target: { value: "B999" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "Datadog monitor alert" },
    });
    fireEvent.click(screen.getByLabelText("Broadcast source-thread reply"));
    fireEvent.change(screen.getByLabelText("Access mode"), {
      target: { value: "full-access" },
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-5" },
    });
    fireEvent.change(screen.getByLabelText("Reasoning"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        backend: "codex",
        executionProfile: {
          executionMode: "full-access",
          model: "gpt-5",
          reasoningEffort: "high",
        },
        name: "Investigate Datadog",
        outputActions: [
          { id: "agent-context", kind: "agent_context" },
          {
            broadcast: true,
            destination: "source_thread",
            id: "source-thread-reply",
            kind: "source_message",
          },
        ],
        schedule: undefined,
        taskPrompt: "Investigate the alert and summarize likely causes.",
        threadId: "thread-1",
        triggers: [
          {
            conversation: {
              channel: "slack",
              conversationId: "C123",
              conversationKind: "channel",
            },
            id: "inbound-message",
            includeThreadReplies: false,
            kind: "inbound_message",
            name: "Datadog monitor alert",
            sender: {
              isBot: true,
              platformUserId: "B999",
            },
            textFilter: {
              mode: "contains",
              text: "Datadog monitor alert",
            },
          },
        ],
      }),
    });
  });

  it("submits an inbound Telegram trigger for a user sender", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Investigate Telegram alert" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate this Telegram report." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));

    expect(screen.getByText(/Each matching inbound message starts/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "telegram" },
    });
    fireEvent.change(screen.getByLabelText("Group or topic ID"), {
      target: { value: "-1001234567890" },
    });
    fireEvent.change(screen.getByLabelText("Telegram user ID"), {
      target: { value: "123456" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "automation alert" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        backend: "codex",
        name: "Investigate Telegram alert",
        triggers: [
          expect.objectContaining({
            conversation: {
              channel: "telegram",
              conversationId: "-1001234567890",
              conversationKind: "channel",
            },
            sender: {
              isBot: false,
              platformUserId: "123456",
            },
            textFilter: {
              mode: "contains",
              text: "automation alert",
            },
          }),
        ],
      }),
    });
  });

  it("offers Agents first and regular threads on the Threads tab", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{ kind: "create" }}
        threads={[
          {
            executionMode: "default",
            id: "agent-thread",
            inbox: { inInbox: false },
            linkedDirectories: [],
            source: "codex",
            title: "Agent transcript",
            titleSource: "explicit",
            updatedAt: 1,
            agent: {
              name: "Inbox Agent",
              instructionLineCount: 0,
              instructionsTooLong: false,
              updatedAt: 1,
            },
          },
          {
            executionMode: "default",
            id: "ordinary-thread",
            inbox: { inInbox: false },
            linkedDirectories: [],
            source: "codex",
            title: "Ordinary work",
            titleSource: "explicit",
            updatedAt: 1,
          },
        ]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("Agent")).toHaveTextContent("Choose Agent");
    fireEvent.click(screen.getByLabelText("Agent"));
    expect(screen.getByRole("option", { name: /Inbox Agent/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ordinary work/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
    expect(screen.getByRole("option", { name: /Ordinary work/ })).toBeInTheDocument();
  });

  it("explains Agents and supports deferring Agent setup while drafting", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{ kind: "create" }}
        threads={[]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "What is an Agent?" }));
    expect(screen.getByRole("note")).toHaveTextContent(
      "thread that is allowed to receive Automation responses",
    );

    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.click(screen.getByRole("option", { name: /I'll set this up later/ }));
    expect(screen.getByLabelText("Agent")).toHaveTextContent(
      "I'll set this up later...",
    );
    fireEvent.click(screen.getByLabelText("Agent"));
    expect(screen.getByRole("option", { name: /I'll set this up later/ }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft automation" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Run once I pick the Agent." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an Agent before saving",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can reassign an existing automation to another Agent", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const automation = buildAutomation({
      threadId: "old-thread",
    });

    render(
      <AutomationEditor
        mode={{ automation, kind: "edit" }}
        threads={[
          buildThread({
            agentName: "Old Jarvis",
            id: "old-thread",
            title: "Old Jarvis transcript",
          }),
          buildThread({
            agentName: "New Jarvis",
            id: "new-thread",
            title: "New Jarvis transcript",
          }),
        ]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("Agent")).toHaveTextContent("Old Jarvis");
    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.click(screen.getByRole("option", { name: /New Jarvis/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "update",
      request: expect.objectContaining({
        automationId: "automation-1",
        backend: "codex",
        threadId: "new-thread",
      }),
    });
  });

  it("labels an assigned Agent without exposing the raw thread id as primary text", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const automation = buildAutomation({
      threadId: "019ed770-c7e9-7031-a4d4-87b9f47ec3e9",
    });

    render(
      <AutomationEditor
        mode={{ automation, kind: "edit" }}
        threads={[]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("Agent")).toHaveTextContent(
      "Current assigned Agent",
    );
    expect(screen.getByLabelText("Agent")).not.toHaveTextContent(
      "019ed770-c7e9-7031-a4d4-87b9f47ec3e9",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "update",
      request: expect.objectContaining({
        backend: "codex",
        threadId: "019ed770-c7e9-7031-a4d4-87b9f47ec3e9",
      }),
    });
  });

  it("promotes a regular thread to an Agent and selects it", async () => {
    const onPromoteThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
    }));
    const onSubmit = vi.fn(async () => undefined);
    const ordinaryThread = buildThread({
      id: "ordinary-thread",
      title: "Incident triage",
    });

    render(
      <AutomationEditor
        mode={{ kind: "create" }}
        threads={[ordinaryThread]}
        onCancel={() => undefined}
        onPromoteThread={onPromoteThread}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
    fireEvent.click(screen.getByRole("option", { name: /Incident triage/ }));

    await waitFor(() => expect(onPromoteThread).toHaveBeenCalledTimes(1));
    expect(onPromoteThread).toHaveBeenCalledWith(ordinaryThread);
    expect(screen.getByLabelText("Agent")).toHaveTextContent("Incident triage");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Summarize incidents" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Summarize recent incident context." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        backend: "codex",
        threadId: "ordinary-thread",
      }),
    });
  });

  it("preserves ACP backend ids when selecting an Agent", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{ kind: "create" }}
        threads={[
          buildThread({
            agentName: "Qwen Agent",
            id: "thread-1",
            source: "acp:qwen",
            title: "Qwen transcript",
          }),
        ]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Check Qwen" },
    });
    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.click(screen.getByRole("option", { name: /Qwen Agent/ }));
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Run this through Qwen." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        backend: "acp:qwen",
        threadId: "thread-1",
      }),
    });
  });

  it("shows inline validation instead of submitting an invalid interval", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bad interval" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Try to run too often." },
    });
    fireEvent.change(screen.getByLabelText("Every"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Interval must be a whole number greater than zero.",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits gate configuration when enabled", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Check email" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Check email and summarize anything urgent." },
    });
    fireEvent.click(screen.getByLabelText("Run script before starting"));
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "node scripts/check-mail.js" },
    });
    fireEvent.change(screen.getByLabelText("Gate working directory"), {
      target: { value: "/tmp/mail-agent" },
    });
    fireEvent.change(screen.getByLabelText("Timeout ms"), {
      target: { value: "120000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          gate: {
            command: "node scripts/check-mail.js",
            cwd: "/tmp/mail-agent",
            timeoutMs: 120000,
          },
        }),
      }),
    );
  });
});

function buildAutomation(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
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
    ...overrides,
  };
}

function buildThread(params: {
  agentName?: string;
  id: string;
  source?: AppServerBackendKind;
  title: string;
}): NavigationThreadSummary {
  return {
    agent: params.agentName
      ? {
          name: params.agentName,
          instructionLineCount: 0,
          instructionsTooLong: false,
          updatedAt: 1,
        }
      : undefined,
    executionMode: "default",
    id: params.id,
    inbox: { inInbox: false },
    linkedDirectories: [],
    source: params.source ?? "codex",
    title: params.title,
    titleSource: "explicit",
    updatedAt: 1,
  };
}
