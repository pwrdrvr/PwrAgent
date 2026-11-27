import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDetail, AutomationMessagingConversationSnapshot } from "@pwragent/shared/contracts/automations";
import type {
  ListTelegramConnectionConversationsResponse,
  MessagingChannelKind,
  MessagingPairingEntry,
} from "@pwragent/shared/contracts/messaging";
import type { ReadDesktopMessagingSettingsResponse, TelegramConnectionStatus } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { AutomationEditor } from "../AutomationEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ORCHARD = `mc_${"a".repeat(32)}`;
const ORIGINAL = `mc_${"b".repeat(32)}`;
const REMOVED = `mc_${"c".repeat(32)}`;
// One group and one person, deliberately the same on both bots.
const GROUP = "-1001234567890";
const ACTOR = "42";

const bots = (orchard: Partial<TelegramConnectionStatus> = {}): TelegramConnectionStatus[] => [
  { id: ORIGINAL, displayName: "Telegram", enabled: true, legacy: true, verified: true },
  { id: ORCHARD, displayName: "Orchard bot", enabled: true, legacy: false, verified: true, ...orchard },
];

const catalogs: Record<string, ListTelegramConnectionConversationsResponse> = {
  "": {
    status: "available",
    supergroups: [{ id: "-1005555555555", displayName: "Packing Line" }],
    users: [],
  },
  [ORCHARD]: {
    status: "available",
    supergroups: [
      { id: GROUP, displayName: "Orchard Ops" },
      { id: "-1009876543210", displayName: "Harvest Alerts" },
    ],
    users: [{ id: ACTOR, displayName: "Dana Okonkwo" }],
  },
};

function settings(originalOn = true): ReadDesktopMessagingSettingsResponse {
  const off = (kind: MessagingChannelKind) => ({
    enabled: { value: kind === "telegram" && originalOn },
    authorizedUserIds: { value: [] },
    authorizedConversations: { value: [] },
    authorizedChannels: { value: [] },
    authorizedGuilds: { value: [] },
  });
  return {
    snapshot: {
      messaging: {
        telegram: {
          ...off("telegram"),
          authorizedSupergroups: { value: [{ id: GROUP, displayName: "Orchard Ops" }] },
          authorizedUserIds: { value: [{ id: ACTOR, displayName: "Dana Okonkwo" }] },
        },
        slack: off("slack"),
        discord: off("discord"),
        mattermost: off("mattermost"),
        feishu: off("feishu"),
        line: off("line"),
      },
    },
  } as unknown as ReadDesktopMessagingSettingsResponse;
}

function botApi(connections: TelegramConnectionStatus[] = bots(), originalOn = true) {
  const pairingListeners: Array<(event: { at: number; entry: MessagingPairingEntry }) => void> = [];
  const api = {
    readMessagingSettings: vi.fn(async () => settings(originalOn)),
    listTelegramConnections: vi.fn(async () => connections),
    listTelegramConnectionConversations: vi.fn(async (request: { connectionId?: string }) =>
      catalogs[request.connectionId ?? ""] ?? { status: "missing" as const, supergroups: [], users: [] }),
    listInboundTopics: vi.fn(async () => ({ topics: [] })),
    generateMessagingPairingToken: vi.fn(async () => ({
      message: "/pair ORCHARD-7",
      entry: { id: "pair-1" },
    })),
    approveMessagingPairing: vi.fn(async () => ({})),
    rejectMessagingPairing: vi.fn(async () => ({})),
    onMessagingPairingChanged: (listener: (event: { at: number; entry: MessagingPairingEntry }) => void) => {
      pairingListeners.push(listener);
      return () => {
        pairingListeners.splice(pairingListeners.indexOf(listener), 1);
      };
    },
  };
  const emitPairing = (entry: Partial<MessagingPairingEntry>) => {
    act(() => {
      for (const listener of pairingListeners) {
        listener({ at: 1, entry: { id: "pair-1", platform: "telegram", ...entry } as MessagingPairingEntry });
      }
    });
  };
  return { api, desktopApi: api as unknown as DesktopApi, emitPairing, listenerCount: () => pairingListeners.length };
}

async function pickConversation(field: string, option: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${field}: `) }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function chooseBot(field: "Bot" | "Destination bot", label: string): Promise<void> {
  await waitFor(() => expect(selectOptionLabels(screen.getByLabelText(new RegExp(`^${field}(?::|$)`)))).toContain(label));
  // A new bot loads its own conversation list; settle that inside act.
  chooseSelectOption(screen.getByLabelText(new RegExp(`^${field}(?::|$)`)), label);
  await act(async () => undefined);
}

function group(connectionId?: string): AutomationMessagingConversationSnapshot {
  return {
    channel: "telegram",
    ...(connectionId === undefined ? {} : { connectionId }),
    conversationId: GROUP,
    conversationKind: "channel",
    title: "Orchard Ops",
  };
}

function savedAutomation(source: AutomationMessagingConversationSnapshot, target: AutomationMessagingConversationSnapshot): AutomationDetail {
  return {
    backend: "codex",
    backlogPolicy: "coalesce",
    createdAt: 1,
    id: "automation-1",
    name: "Orchard deploys",
    scheduleSummary: "On message",
    status: "enabled",
    taskPrompt: "Investigate the deploy.",
    threadId: "thread-1",
    triggers: [{
      id: "inbound-message",
      kind: "inbound_message",
      conversation: source,
      conditionGroup: {
        join: "all",
        conditions: [{ id: "c1", field: "message_text", operator: "contains", values: ["deploy"] }],
      },
    }],
    outputActions: [{ id: "target", kind: "messaging_target", target }],
    updatedAt: 1,
  };
}

type Submitted = { request: { triggers: Array<{ conversation: unknown }>; outputActions: Array<{ kind: string; target?: unknown }> } };

function submitted(onSubmit: ReturnType<typeof vi.fn>) {
  const [[submission]] = onSubmit.mock.calls as [[Submitted]];
  return {
    source: submission.request.triggers[0]?.conversation,
    target: submission.request.outputActions.find((action) => action.kind === "messaging_target")?.target,
  };
}

describe("AutomationEditor Telegram bots", () => {
  it("routes the same group through the bot each picker names", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { api, desktopApi } = botApi();
    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Orchard deploys" } });
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Investigate the deploy." } });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));

    await chooseBot("Bot", "Orchard bot");
    // The Orchard bot's own audience, not the original bot's.
    fireEvent.click(await screen.findByRole("button", { name: /^Conversation: / }));
    expect(await screen.findByRole("option", { name: /Harvest Alerts/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Packing Line/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Orchard Ops/ }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "deploy" } });

    chooseSelectOption(screen.getByLabelText("Where should the result go?"), "Send to a different conversation");
    // A new destination starts on the original bot, like a new trigger.
    expect(screen.getByLabelText(/^Destination bot(?::|$)/)).toHaveTextContent("Telegram");
    await pickConversation("Destination", /Orchard Ops/);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)).toEqual({ source: group(ORCHARD), target: group() });
    expect(api.listTelegramConnectionConversations).toHaveBeenCalledWith({ connectionId: ORCHARD });
    expect(api.listTelegramConnectionConversations).toHaveBeenCalledWith({});
  });

  it("offers Telegram on a named bot while the original bot is off", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { desktopApi } = botApi(
      bots().map((row) => (row.legacy ? { ...row, enabled: false, verified: false } : row)),
      false,
    );
    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Orchard deploys" } });
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Investigate the deploy." } });
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));

    // The running named bot, never the stopped original one.
    await waitFor(() => expect(screen.getByLabelText(/^Bot(?::|$)/)).toHaveTextContent("Orchard bot"));
    await pickConversation("Conversation", /Orchard Ops/);
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit).source).toEqual(group(ORCHARD));
  });

  it("keeps an older definition on the original route without a connection ID", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { desktopApi } = botApi();
    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{ automation: savedAutomation(group(), group()), kind: "edit" }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(/^Bot(?::|$)/)).toHaveTextContent("Telegram"));
    expect(screen.getByLabelText(/^Destination bot(?::|$)/)).toHaveTextContent("Telegram");
    // Saved IDs resolve to the original bot's list by name.
    await screen.findByRole("button", { name: /^Destination: .*Orchard Ops/ });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const { source, target } = submitted(onSubmit);
    expect(source).toEqual(group());
    expect(target).toEqual(group());
    expect(source).not.toHaveProperty("connectionId");
    expect(target).not.toHaveProperty("connectionId");
  });

  it("shows a removed or disabled bot as unavailable and saves it unchanged", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { api, desktopApi } = botApi(bots({ enabled: false, verified: false }));
    render(
      <AutomationEditor
        desktopApi={desktopApi}
        mode={{ automation: savedAutomation(group(REMOVED), group(ORCHARD)), kind: "edit" }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/^Bot(?::|$)/)).toHaveTextContent("Removed bot (unavailable)"));
    expect(screen.getByLabelText(/^Destination bot(?::|$)/)).toHaveTextContent("Orchard bot (disabled)");
    expect(screen.getByText(/This bot is no longer in Settings > Messaging, so this conversation can't start/))
      .toBeInTheDocument();
    expect(screen.getByText(/Orchard bot is turned off in Settings > Messaging, so results can't be sent/))
      .toBeInTheDocument();
    // Neither bot can be picked anew, and the original bot's list is never
    // offered in a removed bot's place.
    expect(selectOptionLabels(screen.getByLabelText(/^Bot(?::|$)/))).toEqual([
      "Telegram", "Orchard bot (disabled)", "Removed bot (unavailable)",
    ]);
    expect(screen.queryByRole("button", { name: /^Conversation: / })).toBeNull();
    expect(api.listTelegramConnectionConversations).not.toHaveBeenCalledWith({});

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)).toEqual({ source: group(REMOVED), target: group(ORCHARD) });
  });

  it("lists topics and registers a group with the selected bot only", async () => {
    const { api, desktopApi, emitPairing, listenerCount } = botApi();
    // Sample the first commit showing the code, before React flushes passive effects.
    let listenersWhenCodeAppeared: number | undefined;
    const recordPairingReadiness = () => {
      if (listenersWhenCodeAppeared === undefined && screen.queryByText("/pair ORCHARD-7")) {
        listenersWhenCodeAppeared = listenerCount();
      }
    };
    render(
      <Profiler id="pairing" onRender={recordPairingReadiness}>
        <AutomationEditor
          desktopApi={desktopApi}
          mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
          onCancel={() => undefined}
          onSubmit={vi.fn(async () => undefined)}
        />
      </Profiler>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inbound message" }));
    await chooseBot("Bot", "Orchard bot");

    fireEvent.click(screen.getByRole("button", { name: "Not sure of the ID? Register with a code" }));
    expect(await screen.findByText("/pair ORCHARD-7")).toBeInTheDocument();
    expect(listenersWhenCodeAppeared).toBe(1);
    expect(api.generateMessagingPairingToken).toHaveBeenCalledWith({
      platform: "telegram", connectionId: ORCHARD, scope: "bucket",
    });
    const observedChat = { id: GROUP, kind: "channel" as const, title: "Orchard Ops" };
    // Pairing IDs are per bot. The original bot's request with the same ID
    // and the same group is not this one.
    emitPairing({ observedChat });
    expect(api.approveMessagingPairing).not.toHaveBeenCalled();
    emitPairing({ connectionId: ORCHARD, observedChat });
    await waitFor(() => expect(api.approveMessagingPairing).toHaveBeenCalledWith({
      entryId: "pair-1", connectionId: ORCHARD,
    }));

    // The approval refreshes the bot's own list, then the settings snapshot.
    await waitFor(() => expect(api.readMessagingSettings).toHaveBeenCalledTimes(2));
    expect(api.listTelegramConnectionConversations).toHaveBeenLastCalledWith({ connectionId: ORCHARD });

    fireEvent.click(screen.getByRole("button", { name: "Specific topic" }));
    await waitFor(() => expect(api.listInboundTopics).toHaveBeenCalledWith({
      provider: "telegram", connectionId: ORCHARD, groupId: GROUP,
    }));
    await act(async () => undefined);
  });
});
