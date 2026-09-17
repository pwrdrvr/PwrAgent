import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendKind,
  AutomationDetail,
  InboundPreviewMessage,
  MessagingChannelKind,
  MessagingPairingEntry,
  NavigationThreadSummary,
  ReadDesktopMessagingSettingsResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { CODEX_AGENT_THREAD_CREATION_NOTE } from "../../../lib/agent-thread";
import { AutomationEditor } from "../AutomationEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The conversation fields are searchable pickers, not `<select>`s: open the
 * field, then click the row. Both waits matter — the authorized lists arrive
 * from an async settings read, so the trigger appears late, and the rows only
 * exist while the panel is open.
 */
async function openConversationPicker(field: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${field}: `) }),
  );
}

async function pickConversation(field: string, option: RegExp) {
  await openConversationPicker(field);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Manual entry is an action beside the list, not one of its options. */
async function pickManualEntry(field: string, action: RegExp) {
  await openConversationPicker(field);
  fireEvent.click(await screen.findByRole("button", { name: action }));
}

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
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "Datadog monitor alert" },
    });
    fireEvent.click(
      screen.getByLabelText("Also broadcast the reply to the channel"),
    );
    // Run settings are the composer's chip dropdowns: click the chip, then
    // pick an option from its listbox.
    fireEvent.click(screen.getByRole("button", { name: "Automation access" }));
    fireEvent.click(screen.getByRole("option", { name: "Full Access" }));
    fireEvent.click(screen.getByRole("button", { name: "Automation model" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "gpt-5" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("option", { name: "gpt-5" }));
    fireEvent.click(screen.getByRole("button", { name: "Automation reasoning" }));
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    fireEvent.change(screen.getByLabelText("Max runs per hour"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        backend: "codex",
        maxRunsPerHour: 5,
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
            name: 'text contains "Datadog monitor alert"',
            conditionGroup: {
              join: "all",
              conditions: [
                {
                  id: expect.any(String),
                  field: "message_text",
                  operator: "contains",
                  values: ["Datadog monitor alert"],
                },
              ],
            },
          },
        ],
      }),
    });
  });

  it("submits prior-run lookback bounds when enabled", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(fakeSettings({ enabled: { slack: true } }))}
        mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
        threads={[]}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Escalation-aware triage" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "If this happened before, raise the urgency." },
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
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });

    fireEvent.click(
      screen.getByLabelText("Show this run the outcomes of its own recent runs"),
    );
    fireEvent.change(screen.getByLabelText("Include up to"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("No older than"), {
      target: { value: String(60 * 60 * 1000) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        priorRunLookback: { maxRuns: 10, maxAgeMs: 60 * 60 * 1000 },
      }),
    });
  });

  it("collapses the filter and throttling stages for a schedule trigger", async () => {
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(fakeSettings({ enabled: { slack: true } }))}
        mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
        threads={[]}
        onCancel={() => {}}
        onSubmit={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    expect(screen.getByRole("heading", { name: "Filters" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Coalescing & rate limit" }),
    ).toBeInTheDocument();

    // A schedule has nothing to filter and nothing to batch, so those stages
    // disappear rather than rendering empty. The remaining stages renumber via
    // a CSS counter, which is why no stage carries a hard-coded number.
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.queryByRole("heading", { name: "Filters" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Coalescing & rate limit" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Trigger" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI evaluation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Where results go" }),
    ).toBeInTheDocument();
  });

  it("offers a Slack channel picker from authorized channels", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { slack: true },
            slackChannels: [{ displayName: "Alerts", id: "C0ALERTS" }],
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
      target: { value: "Slack alerts" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate the alert." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Slack" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "slack" },
    });
    await pickConversation("Channel", /Alerts/);
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create",
        request: expect.objectContaining({
          triggers: [
            expect.objectContaining({
              conversation: expect.objectContaining({
                channel: "slack",
                conversationId: "C0ALERTS",
              }),
            }),
          ],
        }),
      }),
    );
  });

  it.each(["telegram", "discord", "slack", "mattermost", "feishu", "line"] as const)("saves %s DM contacts with recipient identity", async (provider) => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { [provider]: true },
            users: [{ displayName: "Peer", id: "peer-id" }],
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
      target: { value: "Slack alerts" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate the alert." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider")).toHaveValue(provider),
    );
    const conversationLabel = provider === "telegram" ? "Group"
      : provider === "slack" || provider === "discord" ? "Channel"
      : "Conversation";
    await pickConversation(conversationLabel, /Peer/);
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    fireEvent.change(screen.getByLabelText("Where should the result go?"), {
      target: { value: "different" },
    });
    fireEvent.change(screen.getByLabelText("Destination provider"), {
      target: { value: provider },
    });
    const destinationLabel = provider === "telegram" ? "Destination group"
      : provider === "slack" || provider === "discord" ? "Destination channel"
      : "Destination conversation";
    await pickConversation(destinationLabel, /Peer/);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create",
        request: expect.objectContaining({
          outputActions: expect.arrayContaining([
            expect.objectContaining({
              kind: "messaging_target",
              target: expect.objectContaining({ channel: provider, conversationId: "peer-id", recipientUserId: "peer-id", conversationKind: "dm" }),
            }),
          ]),
          triggers: [
            expect.objectContaining({
              conversation: expect.objectContaining({
                channel: provider,
                conversationId: "peer-id",
                recipientUserId: "peer-id",
                conversationKind: "dm",
              }),
            }),
          ],
        }),
      }),
    );
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

    // The funnel itself explains the pipeline now: each stage carries a
    // lead-in verb, and the connectors say what survives into the next stage.
    expect(
      screen.getByRole("heading", { name: "Trigger" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Filters" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Coalescing & rate limit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI evaluation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Where results go" }),
    ).toBeInTheDocument();
    await pickConversation("Group", /Ops Room/);
    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    fireEvent.change(screen.getByLabelText("Topic ID"), {
      target: { value: "42" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
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
            conditionGroup: {
              join: "all",
              conditions: [
                {
                  id: expect.any(String),
                  field: "message_text",
                  operator: "contains",
                  values: ["automation alert"],
                },
              ],
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
    // The authorized group is a row inside the conversation picker, so it is
    // listed once the field is opened.
    await openConversationPicker("Group");
    expect(screen.getByRole("option", { name: /Ops Room/ })).toBeInTheDocument();
  });

  it("offers authorized DMs beside channels, in their own section", async () => {
    // Every provider keeps an `authorizedUserIds` list; leaving it out meant an
    // automation could never watch or answer a direct message.
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { slack: true },
            slackChannels: [{ id: "C_ORCHARD", displayName: "orchard-planning" }],
            slackUsers: [{ id: "D_AVERY", displayName: "Avery Quill" }],
          }),
        )}
        mode={{ kind: "create" }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await openConversationPicker("Channel");
    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Authorized channels", "Authorized direct messages"]);
    expect(
      within(listbox).getByRole("option", { name: /Avery Quill/ }),
    ).toBeInTheDocument();
  });

  it("shows a DM's platform ID in the picker, never the dm: marker", async () => {
    // `dm:` is how the editor marks a contact in its own state. The mono ID
    // column exists so two same-named rows can be told apart by something
    // durable, and `dm:U_AVERY` is not an identifier anyone can paste into
    // Slack — nor one the search box should be matching against.
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { slack: true },
            slackChannels: [{ id: "C_ORCHARD", displayName: "orchard-planning" }],
            slackUsers: [
              { id: "U_AVERY", displayName: "Avery Quill" },
              { id: "U_NAMELESS" },
            ],
          }),
        )}
        mode={{ kind: "create" }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await openConversationPicker("Channel");
    const listbox = screen.getByRole("listbox");
    expect(listbox.textContent).not.toContain("dm:");
    expect(
      within(listbox).getByRole("option", { name: /Avery Quill/ }),
    ).toHaveTextContent("U_AVERY");
    // A contact with no display name is labelled with its own ID. Repeating it
    // in the ID column reads as a second, different identifier.
    expect(
      within(listbox)
        .getByRole("option", { name: /U_NAMELESS/ })
        .textContent?.match(/U_NAMELESS/g),
    ).toHaveLength(1);
  });

  it("saves a manually entered DM as a recipient, not as a channel", async () => {
    // Manual entry could only ever build a channel, so a DM ID typed here
    // saved `conversationKind: "channel"` — which the matcher rejects against
    // every real DM on Slack, Mattermost, Feishu and Discord. The automation
    // looked saved and enabled and never ran, and nothing said why.
    const onSubmit = vi.fn(async () => undefined);

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(fakeSettings({ enabled: { slack: true } }))}
        mode={{
          assignment: { backend: "codex", threadId: "thread-1" },
          kind: "create",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "DM triage" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Summarize what they asked for." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider")).toHaveValue("slack"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Direct message" }));
    // The field asks for the sender's member ID, because that is what the
    // matcher compares — not the D... conversation ID the channel hint names.
    fireEvent.change(screen.getByLabelText("Member ID"), {
      target: { value: "U03QW7ELB19" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "deploy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          triggers: [
            expect.objectContaining({
              conversation: {
                channel: "slack",
                conversationId: "U03QW7ELB19",
                conversationKind: "dm",
                recipientUserId: "U03QW7ELB19",
              },
            }),
          ],
        }),
      }),
    );
  });

  it("keeps a typed ID when the manual surface kind is switched", async () => {
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(fakeSettings({ enabled: { slack: true } }))}
        mode={{ kind: "create" }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider")).toHaveValue("slack"),
    );
    fireEvent.change(screen.getByLabelText("Channel ID"), {
      target: { value: "U03QW7ELB19" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Direct message" }));
    expect(screen.getByLabelText("Member ID")).toHaveValue("U03QW7ELB19");
    fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(screen.getByLabelText("Channel ID")).toHaveValue("U03QW7ELB19");
  });

  it("drops the Telegram destination topic field for a DM", async () => {
    // A 1:1 DM has no forum topics, and `buildDestinationSnapshot` returns
    // before it reads the topic at all — so an operator could fill the field
    // in and have Save discard it without a word.
    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { telegram: true },
            telegramGroups: [{ displayName: "Ops Room", id: "-100" }],
            users: [{ displayName: "Avery Quill", id: "4242" }],
          }),
        )}
        mode={{ kind: "create" }}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.change(screen.getByLabelText("Where should the result go?"), {
      target: { value: "different" },
    });
    await pickConversation("Destination group", /Ops Room/);
    expect(
      screen.getByLabelText("Destination topic ID (optional)"),
    ).toBeInTheDocument();
    await pickConversation("Destination group", /Avery Quill/);
    expect(
      screen.queryByLabelText("Destination topic ID (optional)"),
    ).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    const mcpInput = screen.getByLabelText("Allowed MCP servers");
    fireEvent.change(mcpInput, { target: { value: "datadog" } });
    fireEvent.keyDown(mcpInput, { key: "Enter" });
    fireEvent.change(mcpInput, { target: { value: "aws-readonly" } });
    fireEvent.keyDown(mcpInput, { key: "Enter" });
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
      readMessagingSettings: async () => fakeSettings({ enabled: { telegram: true } }),
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
      readMessagingSettings: async () => fakeSettings({ enabled: { telegram: true } }),
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
    // The code is copyable (the app root sets user-select: none).
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();

    await waitFor(() => expect(pairingListener).toBeDefined());
    act(() => {
      pairingListener!({
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
      readMessagingSettings: async () => fakeSettings({ enabled: { telegram: true } }),
      startInboundPreview: vi.fn(async () => ({ ok: true })),
      stopInboundPreview: vi.fn(async () => undefined),
      onInboundPreviewMessage: (
        callback: (message: InboundPreviewMessage) => void,
      ) => {
        previewListener = callback;
        return () => undefined;
      },
    } as unknown as DesktopApi;
    const onSubmit = vi.fn(async () => undefined);

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

    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    fireEvent.change(screen.getByLabelText("Group ID"), {
      target: { value: "-100" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
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
    const matchRow = matching.closest(".automation-preview__item");
    expect(matchRow).toHaveClass("is-match");
    expect(
      nonMatching.closest(".automation-preview__item"),
    ).not.toHaveClass("is-match");

    // The sender ID is visible (not just the display name) and copyable, and
    // "Use sender" adds that sender as a condition rather than making the
    // operator copy an opaque platform id into a text box.
    expect(matchRow).toHaveTextContent("B1");
    fireEvent.click(
      matchRow!.querySelector(".automation-preview__use-sender") as Element,
    );
    const senderChips = screen.getAllByRole("listitem").filter((item) =>
      item.classList.contains("automation-sender-chip"),
    );
    expect(senderChips).toHaveLength(1);
    expect(senderChips[0]).toHaveTextContent("Datadog");

    // The resolved display name must survive the round trip: it is stamped
    // onto the condition at submit so reopening the editor (and the list
    // screen's trigger summary) shows "Datadog", not the raw platform id.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Label persistence" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = (onSubmit.mock.calls[0] as unknown[])[0] as {
      request: {
        triggers: Array<{
          name?: string;
          conditionGroup?: {
            conditions: Array<{ field: string; valueLabels?: Record<string, string> }>;
          };
        }>;
      };
    };
    const senderCondition =
      submitted.request.triggers[0]?.conditionGroup?.conditions.find(
        (entry) => entry.field === "sender",
      );
    expect(senderCondition?.valueLabels).toEqual({ B1: "Datadog" });
    expect(submitted.request.triggers[0]?.name).toContain("Datadog");
    // The plain-language summary lives on the funnel connector below the
    // Filters stage, so it states what survives into the next stage.
    expect(
      screen.getByText(/sender is Datadog/i, {
        selector: ".automation-flow__caption",
      }),
    ).toBeInTheDocument();
  });

  it("offers a topic picker from known topics and submits its name", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const desktopApi = {
      readMessagingSettings: async () =>
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
    await pickConversation("Group", /Ops Room/);
    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    await pickConversation("Topic", /Incidents/);
    fireEvent.change(screen.getByLabelText("Value"), {
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

  it("emits only an Agent-context action for agent-only result mode", async () => {
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
      target: { value: "Quiet incident memory" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Record the incident for later." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await pickConversation("Group", /Ops Room/);
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    fireEvent.change(screen.getByLabelText("Where should the result go?"), {
      target: { value: "agent_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "create",
      request: expect.objectContaining({
        outputActions: [{ id: "agent-context", kind: "agent_context" }],
      }),
    });
  });

  it("clears a stale topic when the group changes", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const desktopApi = {
      readMessagingSettings: async () =>
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
      target: { value: "Topic reset" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Investigate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await pickConversation("Group", /Ops Room/);
    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    await pickConversation("Topic", /Incidents/);
    // Switch the group to manual entry — the previously chosen topic must clear.
    await pickManualEntry("Group", /Enter Group ID manually/);
    fireEvent.change(screen.getByLabelText("Group ID"), {
      target: { value: "-200" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // Topic was cleared, so submit is blocked rather than sending a stale topic.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a topic ID or switch to Whole group.",
    );
    expect(onSubmit).not.toHaveBeenCalled();
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
    await pickConversation("Group", /Ops Room/);
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "ERROR" },
    });
    fireEvent.change(screen.getByLabelText("Where should the result go?"), {
      target: { value: "different" },
    });
    await pickManualEntry("Destination group", /Enter Group ID manually/);
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

  it("preselects a saved destination channel on edit so its title survives re-save", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const automation: AutomationDetail = {
      backend: "codex",
      threadId: "thread-1",
      id: "auto-1",
      name: "Slack alerts",
      status: "enabled",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C0IN" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      scheduleSummary: "On inbound message",
      backlogPolicy: "coalesce",
      updatedAt: 1,
      createdAt: 1,
      taskPrompt: "Investigate.",
      outputActions: [
        { id: "agent-context", kind: "agent_context" },
        {
          id: "messaging-target",
          kind: "messaging_target",
          target: {
            channel: "slack",
            conversationId: "C0ALERTS",
            conversationKind: "channel",
            title: "Alerts",
          },
        },
      ],
    };

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { slack: true },
            slackChannels: [{ displayName: "Alerts", id: "C0ALERTS" }],
          }),
        )}
        mode={{ kind: "edit", automation }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    // Once channels load, the saved destination is preselected in the dropdown
    // (not "Enter manually"), so selectedDestGroup resolves.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Destination channel: / }),
      ).toHaveAccessibleName(/Alerts/),
    );

    // Re-saving without touching the destination must keep its friendly title.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update",
        request: expect.objectContaining({
          outputActions: expect.arrayContaining([
            expect.objectContaining({
              kind: "messaging_target",
              target: expect.objectContaining({
                channel: "slack",
                conversationId: "C0ALERTS",
                title: "Alerts",
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("preselects the saved trigger channel on edit so its title survives re-save", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const automation: AutomationDetail = {
      backend: "codex",
      threadId: "thread-1",
      id: "auto-1",
      name: "Search bots",
      status: "enabled",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: {
            channel: "slack",
            conversationId: "C2LE02620",
            conversationKind: "channel",
            title: "t-search-bots",
          },
          conditionGroup: {
            join: "any",
            conditions: [
              {
                id: "c1",
                field: "sender",
                operator: "is_one_of",
                values: ["B1"],
                valueLabels: { B1: "spinnaker" },
              },
            ],
          },
        },
      ],
      scheduleSummary: "On inbound message",
      backlogPolicy: "coalesce",
      updatedAt: 1,
      createdAt: 1,
      taskPrompt: "Investigate.",
      outputActions: [{ id: "agent-context", kind: "agent_context" }],
    };

    render(
      <AutomationEditor
        desktopApi={fakeDesktopApi(
          fakeSettings({
            enabled: { slack: true },
            slackChannels: [{ displayName: "t-search-bots", id: "C2LE02620" }],
          }),
        )}
        mode={{ kind: "edit", automation }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    // Once the channel catalog loads, the saved trigger conversation is
    // preselected by name — not left on "Enter Channel ID manually…" showing
    // the raw platform id.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Channel: / }),
      ).toHaveAccessibleName(/t-search-bots/),
    );

    // Re-saving without touching the channel must keep its friendly title.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update",
        request: expect.objectContaining({
          triggers: [
            expect.objectContaining({
              conversation: expect.objectContaining({
                conversationId: "C2LE02620",
                title: "t-search-bots",
              }),
            }),
          ],
        }),
      }),
    );
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
            source: "acp:gemini",
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

  it("does not offer existing Codex threads for Agent promotion", () => {
    const ordinaryCodexThread = buildThread({
      id: "ordinary-thread",
      title: "Incident triage",
    });

    render(
      <AutomationEditor
        mode={{ kind: "create" }}
        threads={[ordinaryCodexThread]}
        onCancel={() => undefined}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByLabelText("Agent"));
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));

    expect(screen.getByText(CODEX_AGENT_THREAD_CREATION_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Incident triage/ }),
    ).not.toBeInTheDocument();
  });

  it("promotes a regular thread to an Agent and selects it", async () => {
    const onPromoteThread = vi.fn(async () => ({
      backend: "acp:gemini" as const,
      threadId: "ordinary-thread",
    }));
    const onSubmit = vi.fn(async () => undefined);
    const ordinaryThread = buildThread({
      id: "ordinary-thread",
      source: "acp:gemini",
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
        backend: "acp:gemini",
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

/** `displayName` is optional in the real snapshot: PwrAgent does not always
 *  have a name for an authorized contact, and a row for one it cannot name is
 *  a case the picker has to render. */
type AuthorizedEntry = { displayName?: string; id: string };

function fakeSettings(params: {
  enabled: Partial<Record<MessagingChannelKind, boolean>>;
  users?: AuthorizedEntry[];
  telegramGroups?: AuthorizedEntry[];
  slackChannels?: AuthorizedEntry[];
  slackUsers?: AuthorizedEntry[];
}): ReadDesktopMessagingSettingsResponse {
  const provider = (kind: MessagingChannelKind) => ({
    enabled: { value: Boolean(params.enabled[kind]) },
    authorizedUserIds: { value: params.users ?? [] },
    authorizedConversations: { value: [] },
    authorizedChats: { value: [] },
    authorizedGroups: { value: [] },
    authorizedRooms: { value: [] },
  });
  return {
    snapshot: {
      messaging: {
        telegram: {
          authorizedUserIds: { value: params.users ?? [] },
          enabled: { value: Boolean(params.enabled.telegram) },
          authorizedSupergroups: { value: params.telegramGroups ?? [] },
        },
        slack: {
          enabled: { value: Boolean(params.enabled.slack) },
          authorizedChannels: { value: params.slackChannels ?? [] },
          authorizedUserIds: { value: params.slackUsers ?? params.users ?? [] },
        },
        discord: provider("discord"),
        mattermost: provider("mattermost"),
        feishu: provider("feishu"),
        line: provider("line"),
      },
    },
  } as unknown as ReadDesktopMessagingSettingsResponse;
}

function fakeDesktopApi(settings: ReadDesktopMessagingSettingsResponse): DesktopApi {
  return {
    readMessagingSettings: async () => settings,
    // The execution Model/Reasoning selects are populated from this catalog —
    // the same source the composer reads — so tests that pick a model exercise
    // the real wiring instead of a hardcoded list.
    listBackends: async () => ({
      fetchedAt: 0,
      backends: [
        {
          kind: "codex",
          label: "Codex",
          available: true,
          methods: [],
          capabilities: {},
          executionModes: [],
          launchpadOptions: {
            models: [
              {
                id: "gpt-5",
                reasoningEfforts: ["low", "medium", "high"],
              },
              { id: "gpt-5.4-mini" },
            ],
            reasoningEfforts: ["low", "medium", "high"],
          },
        },
      ],
    }),
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
