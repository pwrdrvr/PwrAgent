import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDetail, NavigationThreadSummary } from "@pwragent/shared";
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
        name: "Check email",
        schedule: {
          every: 5,
          kind: "interval",
          unit: "minutes",
        },
        taskPrompt: "Check email and summarize anything urgent.",
        threadId: "thread-1",
      },
    });
  });

  it("only offers Agent threads from the global picker", async () => {
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

    expect(screen.getByLabelText("Agent")).toHaveDisplayValue("Choose Agent");
    expect(screen.getByRole("option", { name: "Inbox Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ordinary work" })).not.toBeInTheDocument();
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

    expect(screen.getByLabelText("Agent")).toHaveDisplayValue("Old Jarvis");
    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "codex:new-thread" },
    });
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
    fireEvent.change(screen.getByLabelText("Working directory"), {
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
    updatedAt: 1,
    ...overrides,
  };
}

function buildThread(params: {
  agentName?: string;
  id: string;
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
    source: "codex",
    title: params.title,
    titleSource: "explicit",
    updatedAt: 1,
  };
}
