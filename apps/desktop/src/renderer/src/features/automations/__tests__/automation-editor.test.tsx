import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendKind,
  AutomationDetail,
  InboundPreviewMessage,
  MessagingChannelKind,
  MessagingPairingEntry,
  NavigationThreadSummary,
  ReadDesktopSettingsResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
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
        desktopApi={fakeDesktopApi(
          fakeSettings({ enabled: { slack: true, telegram: true } }),
        )}
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
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Slack" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "slack" },
    });
    fireEvent.change(screen.getByLabelText("Channel ID"), {
      target: { value: "C123" },
    });
    fireEvent.change(screen.getByLabelText("Sender type"), {
      target: { value: "true" },
    });
    fireEvent.change(screen.getByLabelText("Sender ID (optional)"), {
      target: { value: "B999" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "Datadog monitor alert" },
    });
    fireEvent.click(
      screen.getByLabelText("Also broadcast the reply to the channel"),
    );
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

  it("submits an inbound Telegram trigger scoped to a specific topic", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { telegram: true },
            telegramGroups: [{ displayName: "Ops Room", id: "-1001234567890" }],
          }),
        )}
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
    // The authorized group appears in the picker once settings load.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Ops Room" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Group"), {
      target: { value: "-1001234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    fireEvent.change(screen.getByLabelText("Topic ID"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByLabelText("Sender type"), {
      target: { value: "false" },
    });
    fireEvent.change(screen.getByLabelText("Sender ID (optional)"), {
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
              conversationId: "42",
              conversationKind: "topic",
              parentId: "-1001234567890",
              parentTitle: "Ops Room",
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

  it("only lists enabled providers and surfaces authorized groups", async () => {
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { telegram: true },
            telegramGroups: [{ displayName: "Ops Room", id: "-100777" }],
          }),
        )}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Slack" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: "Telegram" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ops Room" })).toBeInTheDocument();
  });

  it("includes an MCP allowlist in the execution profile", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({ enabled: { telegram: true } }),
        )}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Datadog incident bot" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate using Datadog." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.change(screen.getByLabelText("Group ID"), {
      target: { value: "-1001234567890" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "ERROR" },
    });
    fireEvent.change(screen.getByLabelText("Allowed MCP servers"), {
      target: { value: "datadog, aws-readonly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        executionProfile: { mcpAllowlist: ["datadog", "aws-readonly"] },
      }),
    });
  });

  it("drafts a task prompt from a plain description", async () => {
    const draftAutomationPrompt = vi.fn(async () => ({
      status: "generated" as const,
      prompt: "Investigate the alert in the incoming message and summarize it.",
    }));
    const desktopApi = {
      readSettings: async () => fakeSettings({ enabled: { telegram: true } }),
      draftAutomationPrompt,
    } as unknown as DesktopApi;

    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Help me write a prompt" }),
    );
    fireEvent.change(
      screen.getByLabelText("Describe what you want the automation to do"),
      { target: { value: "tell me what's wrong when Datadog alerts" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft prompt" }));

    await waitFor(() =>
      expect(draftAutomationPrompt).toHaveBeenCalledWith({
        description: "tell me what's wrong when Datadog alerts",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Task prompt")).toHaveValue(
        "Investigate the alert in the incoming message and summarize it.",
      ),
    );
  });

  it("captures a Telegram topic via a pairing code", async () => {
    let pairingListener:
      | ((event: { at: number; entry: MessagingPairingEntry }) => void)
      | undefined;
    const approve = vi.fn(async () => ({
      added: true,
      entry: { id: "pair-1" } as MessagingPairingEntry,
    }));
    const desktopApi = {
      readSettings: async () => fakeSettings({ enabled: { telegram: true } }),
      generateMessagingPairingToken: async () => ({
        entry: { id: "pair-1" } as MessagingPairingEntry,
        expiresAt: 0,
        message: "Send this code: ABC123",
        token: "ABC123",
      }),
      onMessagingPairingChanged: (
        callback: (event: { at: number; entry: MessagingPairingEntry }) => void,
      ) => {
        pairingListener = callback;
        return () => undefined;
      },
      approveMessagingPairing: approve,
      rejectMessagingPairing: async () => ({ entry: { id: "pair-1" } }),
    } as unknown as DesktopApi;

    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Register with a code/ }),
    );
    expect(await screen.findByText(/Send this code: ABC123/)).toBeInTheDocument();

    act(() => {
      pairingListener?.({
        at: 1,
        entry: {
          id: "pair-1",
          observedChat: {
            bucketId: "-100999",
            id: "42",
            kind: "topic",
            parentId: "-100999",
            parentTitle: "Ops",
            title: "Incidents",
          },
        } as MessagingPairingEntry,
      });
    });

    expect(
      await screen.findByText(/Captured Incidents and authorized/),
    ).toBeInTheDocument();
    expect((screen.getByLabelText("Group ID") as HTMLInputElement).value).toBe(
      "-100999",
    );
    expect((screen.getByLabelText("Topic ID") as HTMLInputElement).value).toBe(
      "42",
    );
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith({ entryId: "pair-1" }),
    );
  });

  it("previews live messages and highlights ones the filter matches", async () => {
    let previewListener: ((message: InboundPreviewMessage) => void) | undefined;
    const desktopApi = {
      readSettings: async () => fakeSettings({ enabled: { telegram: true } }),
      startInboundPreview: vi.fn(async () => ({ ok: true })),
      stopInboundPreview: vi.fn(async () => undefined),
      onInboundPreviewMessage: (
        callback: (message: InboundPreviewMessage) => void,
      ) => {
        previewListener = callback;
        return () => undefined;
      },
    } as unknown as DesktopApi;

    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.change(screen.getByLabelText("Group ID"), {
      target: { value: "-100" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "ERROR" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview live messages" }),
    );

    await waitFor(() =>
      expect(desktopApi.startInboundPreview).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "-100", provider: "telegram" }),
      ),
    );

    act(() => {
      previewListener?.({
        actor: { displayName: "Datadog", isBot: true, platformUserId: "B1" },
        conversationId: "-100",
        id: "m1",
        provider: "telegram",
        receivedAt: 1,
        text: "ERROR api latency",
      });
      previewListener?.({
        actor: { displayName: "Alice", platformUserId: "U2" },
        conversationId: "-100",
        id: "m2",
        provider: "telegram",
        receivedAt: 2,
        text: "good morning",
      });
    });

    const matching = await screen.findByText("ERROR api latency");
    const nonMatching = screen.getByText("good morning");
    expect(matching.closest(".automation-preview__item")).toHaveClass("is-match");
    expect(
      nonMatching.closest(".automation-preview__item"),
    ).not.toHaveClass("is-match");
  });

  it("offers a topic picker from known topics and submits its name", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const desktopApi = {
      readSettings: async () =>
        fakeSettings({
          enabled: { telegram: true },
          telegramGroups: [{ displayName: "Ops Room", id: "-100" }],
        }),
      listInboundTopics: async () => ({
        topics: [{ id: "42", title: "Incidents" }],
      }),
    } as unknown as DesktopApi;

    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Incident bot" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Ops Room" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Group"), {
      target: { value: "-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Incidents" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Topic"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "ERROR" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        triggers: [
          expect.objectContaining({
            conversation: {
              channel: "telegram",
              conversationId: "42",
              conversationKind: "topic",
              parentId: "-100",
              title: "Incidents",
              parentTitle: "Ops Room",
            },
          }),
        ],
      }),
    });
  });

  it("sends the result to a different conversation via messaging_target", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { telegram: true },
            telegramGroups: [{ displayName: "Ops Room", id: "-100" }],
          }),
        )}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Datadog to ops channel" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate and report." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Ops Room" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Group"), {
      target: { value: "-100" },
    });
    fireEvent.change(screen.getByLabelText("Text contains"), {
      target: { value: "ERROR" },
    });
    fireEvent.change(screen.getByLabelText("Where should the result go?"), {
      target: { value: "different" },
    });
    fireEvent.change(screen.getByLabelText("Destination group"), {
      target: { value: "__manual__" },
    });
    fireEvent.change(screen.getByLabelText("Destination group ID"), {
      target: { value: "-200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        outputActions: [
          { id: "agent-context", kind: "agent_context" },
          {
            id: "messaging-target",
            kind: "messaging_target",
            target: {
              channel: "telegram",
              conversationId: "-200",
              conversationKind: "channel",
            },
          },
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

function fakeSettings(params: {
  enabled: Partial<Record<MessagingChannelKind, boolean>>;
  telegramGroups?: Array<{ displayName: string; id: string }>;
}): ReadDesktopSettingsResponse {
  const provider = (kind: MessagingChannelKind) => ({
    enabled: { value: Boolean(params.enabled[kind]) },
  });
  return {
    snapshot: {
      messaging: {
        telegram: {
          enabled: { value: Boolean(params.enabled.telegram) },
          authorizedSupergroups: { value: params.telegramGroups ?? [] },
        },
        slack: provider("slack"),
        discord: provider("discord"),
        mattermost: provider("mattermost"),
        feishu: provider("feishu"),
        line: provider("line"),
      },
    },
  } as unknown as ReadDesktopSettingsResponse;
}

function fakeDesktopApi(settings: ReadDesktopSettingsResponse): DesktopApi {
  return {
    readSettings: async () => settings,
  } as unknown as DesktopApi;
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
