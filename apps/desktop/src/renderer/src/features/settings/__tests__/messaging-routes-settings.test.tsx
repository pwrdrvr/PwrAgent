import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendKind,
  ListMessagingRoutesResponse,
  MessagingChannelKind,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  ApprovedSurfaceDefaultAgent,
  MessagingRoutesProvider,
  MessagingRoutesSettings,
} from "../MessagingRoutesSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildRoutes(): ListMessagingRoutesResponse {
  return {
    eligibleAgents: [
      {
        backend: "codex",
        threadId: "agent-1",
        label: "Search Signals Agent",
        backendLabel: "Codex",
        backendAvailable: true,
        available: true,
      },
      {
        backend: "acp:grok",
        threadId: "agent-2",
        label: "Grok Project Agent",
        backendLabel: "Grok Build",
        backendAvailable: true,
        available: true,
      },
    ],
    defaultAgents: [
      {
        assignmentId: "assignment-1",
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C13056",
            kind: "channel",
            title: "p-search-signals-project",
            workspaceId: "T1",
          },
        },
        target: {
          backend: "codex",
          threadId: "agent-1",
          label: "Search Signals Agent",
          backendLabel: "Codex",
          backendAvailable: true,
          available: true,
        },
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        assignmentId: "assignment-stale",
        scope: { kind: "profile" },
        target: {
          backend: "acp:missing",
          threadId: "missing-agent",
          label: "Missing Agent",
          backendLabel: "Missing",
          backendAvailable: false,
          available: false,
        },
        createdAt: 1000,
        updatedAt: 1500,
      },
    ],
    bindings: [
      {
        bindingId: "binding-1",
        platform: "slack",
        conversation: {
          id: "1700000000.000100",
          kind: "thread",
          title: "13056 investigation",
          parentTitle: "p-search-signals-project",
        },
        target: {
          backend: "codex",
          backendLabel: "Codex",
          backendAvailable: true,
          threadId: "work-1",
          label: "Issue 13056",
          kind: "thread",
        },
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    observedSurfaces: [
      {
        platform: "slack",
        conversation: {
          id: "C13056",
          kind: "channel",
          title: "p-search-signals-project",
          workspaceId: "T1",
        },
        firstSeenAt: 1000,
        lastSeenAt: 2000,
      },
      {
        platform: "slack",
        conversation: {
          id: "C10000",
          kind: "channel",
          title: "archived-project",
          workspaceId: "T1",
        },
        firstSeenAt: 500,
        lastSeenAt: 1000,
      },
    ],
  };
}

function buildDesktopApi(routes = buildRoutes()) {
  const listMessagingRoutes = vi.fn<
    NonNullable<DesktopApi["listMessagingRoutes"]>
  >(async () => routes);
  const setMessagingDefaultAgent = vi.fn<
    NonNullable<DesktopApi["setMessagingDefaultAgent"]>
  >(async (request) => ({
    assignmentId: request.assignmentId ?? "assignment-new",
  }));
  const clearMessagingDefaultAgent = vi.fn<
    NonNullable<DesktopApi["clearMessagingDefaultAgent"]>
  >(async (request) => ({ ...request, cleared: true }));
  const unbindMessagingThread = vi.fn<
    NonNullable<DesktopApi["unbindMessagingThread"]>
  >(async (request) => ({ ...request, revoked: true }));
  const desktopApi: DesktopApi = {
    listMessagingRoutes,
    setMessagingDefaultAgent,
    clearMessagingDefaultAgent,
    unbindMessagingThread,
    onMessagingBindingsChanged: () => () => undefined,
  };
  return {
    desktopApi,
    listMessagingRoutes,
    setMessagingDefaultAgent,
    clearMessagingDefaultAgent,
    unbindMessagingThread,
  };
}

function renderRoutes(
  desktopApi: DesktopApi,
  onOpenThread?: (target: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void,
  configuredPlatforms?: readonly MessagingChannelKind[],
) {
  return render(
    <MessagingRoutesProvider desktopApi={desktopApi}>
      <MessagingRoutesSettings
        configuredPlatforms={configuredPlatforms}
        desktopApi={desktopApi}
        onOpenThread={onOpenThread}
      />
    </MessagingRoutesProvider>,
  );
}

describe("MessagingRoutesSettings", () => {
  it("sets Discord response behavior from named surfaces without touching routes", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces.push({
      platform: "discord",
      conversation: {
        id: "1480556454498009352",
        kind: "channel",
        title: "general",
        ancestorTitle: "Test server",
        workspaceId: "1480556454498009353",
      },
      firstSeenAt: 1000,
      lastSeenAt: 3000,
    });
    const api = buildDesktopApi(routes);
    const onSave = vi.fn();

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{ source: "config", value: [], onSave }}
        />
      </MessagingRoutesProvider>,
    );

    // The picker offers the observed channel by name. An operator never types
    // a snowflake to set response behavior.
    const picker = await screen.findByRole("combobox", {
      name: "Add a channel or thread",
    });
    const named = await screen.findByRole("option", {
      name: "Discord / Test server / general",
    });
    fireEvent.change(picker, { target: { value: "1480556454498009352" } });

    expect(named).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith([
      {
        id: "1480556454498009352",
        displayName: "general",
        responseMode: "mention_only",
      },
    ]);
    // Admission and routing are independent: choosing when to respond must not
    // assign, clear, or otherwise disturb a default Agent.
    expect(api.setMessagingDefaultAgent).not.toHaveBeenCalled();
    expect(api.clearMessagingDefaultAgent).not.toHaveBeenCalled();
  });

  it("assigns a default Agent without writing response behavior", async () => {
    const api = buildDesktopApi();
    const onSave = vi.fn();

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{
            source: "config",
            value: [
              {
                id: "1480556454498009352",
                displayName: "general",
                responseMode: "mention_only",
              },
            ],
            onSave,
          }}
        />
      </MessagingRoutesProvider>,
    );

    fireEvent.click((await screen.findAllByRole("button", { name: "Change" }))[0]!);
    fireEvent.change(screen.getByLabelText("Route Working Updates"), {
      target: { value: "show_all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalled();
    });
    // The mirror of the test above: changing the route leaves the configured
    // response behavior exactly as it was.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows an empty inventory when no messaging routes exist", async () => {
    const { desktopApi } = buildDesktopApi({
      eligibleAgents: [],
      defaultAgents: [],
      bindings: [],
      observedSurfaces: [],
    });

    renderRoutes(desktopApi);

    expect(
      await screen.findByText("No default Agents configured."),
    ).toBeInTheDocument();
    expect(screen.getByText("No active bindings.")).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add default" })).toBeDisabled();
  });

  it("shows a complete default and binding inventory", async () => {
    const { desktopApi } = buildDesktopApi();

    renderRoutes(desktopApi);

    expect(
      await screen.findByText("Slack / p-search-signals-project"),
    ).toBeInTheDocument();
    expect(screen.getByText("Search Signals Agent")).toBeInTheDocument();
    expect(screen.getByText("Missing unavailable")).toBeInTheDocument();
    expect(screen.getByText(/13056 investigation/)).toBeInTheDocument();
    expect(screen.getByText("Issue 13056")).toBeInTheDocument();
    expect(screen.getAllByText("Codex")).toHaveLength(2);
    expect(screen.getByText("3 active")).toBeInTheDocument();
    // Routes that inherit the default carry no chip at all — the marker is
    // for the exception, not for repeating the profile default on every row.
    expect(screen.queryByText(/^Updates:/)).not.toBeInTheDocument();
  });

  it("sets and clears a per-route Working Updates override", async () => {
    const routes = buildRoutes();
    routes.defaultAgents[0] = {
      ...routes.defaultAgents[0]!,
      toolUpdateMode: "show_more",
    };
    const api = buildDesktopApi(routes);

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          agentRouteToolUpdateMode="show_none"
          desktopApi={api.desktopApi}
        />
      </MessagingRoutesProvider>,
    );

    // Kept short so the chip survives the narrow target column; the full
    // phrase stays in the row's aria-label and the chip's title.
    expect(await screen.findByText("Updates: Show More")).toHaveClass(
      "messaging-route-row__provider-chip",
    );
    expect(
      screen.getByRole("button", {
        name: /Working Updates override Show More/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    expect(screen.getByLabelText("Route Working Updates")).toHaveValue(
      "show_more",
    );
    expect(screen.getByLabelText("Route Working Updates")).toHaveDisplayValue(
      "Show More",
    );
    expect(screen.getByRole("option", { name: "Show Less" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: "Use manager-agent default (Show None)",
      }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Route Working Updates"), {
      target: { value: "show_all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          assignmentId: "assignment-1",
          toolUpdateMode: "show_all",
        }),
      );
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.change(screen.getByLabelText("Route Working Updates"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          assignmentId: "assignment-1",
          toolUpdateMode: null,
        }),
      );
    });
  });

  it("distinguishes untitled topics in the same messaging group", async () => {
    const routes = buildRoutes();
    const first = routes.defaultAgents[0]!;
    const topicScope = {
      kind: "conversation" as const,
      platform: "telegram" as const,
      conversation: {
        id: "119",
        kind: "topic" as const,
        parentId: "-1001",
        parentTitle: "PwrAgent Mini Dev Group",
      },
    };
    routes.defaultAgents = [
      { ...first, scope: topicScope },
      {
        ...first,
        assignmentId: "assignment-2",
        scope: {
          ...topicScope,
          conversation: { ...topicScope.conversation, id: "600" },
        },
      },
    ];
    routes.bindings = [];
    const { desktopApi } = buildDesktopApi(routes);

    renderRoutes(desktopApi);

    expect(
      await screen.findByText(
        "Telegram / PwrAgent Mini Dev Group / Topic 119",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Telegram / PwrAgent Mini Dev Group / Topic 600"),
    ).toBeInTheDocument();
  });

  it("shows an unavailable provider chip when a legacy binding is unresolved", async () => {
    const routes = buildRoutes();
    routes.defaultAgents = [];
    routes.bindings[0]!.target = {
      threadId: "unknown-thread",
      label: "Unknown thread",
      kind: "thread",
    };
    const { desktopApi } = buildDesktopApi(routes);

    renderRoutes(desktopApi);

    expect(
      await screen.findByText("Unknown provider unavailable"),
    ).toHaveClass("chip", "chip--backend", "is-stale");
  });

  it("opens default Agent and binding target threads", async () => {
    const { desktopApi } = buildDesktopApi();
    const onOpenThread = vi.fn();

    renderRoutes(desktopApi, onOpenThread);
    await screen.findByText("Issue 13056");

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Search Signals Agent" }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "agent-1",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Issue 13056" }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "work-1",
    });
  });

  it("shows and changes a direct default from an approved surface", async () => {
    const api = buildDesktopApi();

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <ApprovedSurfaceDefaultAgent
          id="C13056"
          label="Channel default Agent"
          platform="slack"
          scopeKind="conversation"
          title="p-search-signals-project"
        />
        <MessagingRoutesSettings desktopApi={api.desktopApi} />
      </MessagingRoutesProvider>,
    );

    expect(await screen.findByText("Channel default Agent")).toBeInTheDocument();
    expect(screen.getAllByText("Search Signals Agent")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Change default Agent for p-search-signals-project",
      }),
    );

    expect(screen.getByText("Change default Agent")).toBeInTheDocument();
    expect(
      screen.getAllByText("Slack / p-search-signals-project"),
    ).toHaveLength(2);
    expect(api.listMessagingRoutes).toHaveBeenCalledTimes(1);
  });

  it("prefills a new default from an approved surface", async () => {
    const api = buildDesktopApi();

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <ApprovedSurfaceDefaultAgent
          id="C200"
          label="Channel default Agent"
          platform="slack"
          scopeKind="conversation"
          title="incident-response"
        />
        <MessagingRoutesSettings desktopApi={api.desktopApi} />
      </MessagingRoutesProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Assign default Agent for incident-response",
      }),
    );

    expect(screen.getByLabelText("Default scope")).toHaveValue("conversation");
    expect(screen.getByLabelText("Messaging platform")).toHaveValue("slack");
    expect(screen.getByLabelText("Messaging surface")).toHaveDisplayValue(
      "Slack / incident-response - approved configuration",
    );
    expect(screen.queryByLabelText("Conversation ID")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["codex", "agent-1"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C200",
            kind: "channel",
            title: "incident-response",
          },
        },
        target: { backend: "codex", threadId: "agent-1" },
      });
    });
  });

  it("adds a conversation default from a recently seen surface", async () => {
    const api = buildDesktopApi();
    renderRoutes(api.desktopApi);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    fireEvent.change(screen.getByLabelText("Messaging surface"), {
      target: {
        value: JSON.stringify([
          "conversation",
          "slack",
          "channel",
          "",
          "C13056",
        ]),
      },
    });
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["acp:grok", "agent-2"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C13056",
            kind: "channel",
            title: "p-search-signals-project",
            workspaceId: "T1",
          },
        },
        target: { backend: "acp:grok", threadId: "agent-2" },
      });
    });
  });

  it("routes a selected Slack channel as an exact conversation, not a parent fallback", async () => {
    const routes = buildRoutes();
    routes.defaultAgents = [];
    routes.bindings = [];
    routes.observedSurfaces = [
      {
        platform: "slack",
        conversation: {
          id: "C0BN6UXFREE",
          kind: "channel",
          title: "p-pwragent-testing",
          workspaceId: "T1",
        },
        firstSeenAt: 1000,
        lastSeenAt: 2000,
      },
    ];
    const api = buildDesktopApi(routes);
    renderRoutes(api.desktopApi);
    await screen.findByText("No default Agents configured.");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    expect(
      screen.getByRole("option", {
        name: "Threads/topics in a channel or group",
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "parent" },
    });
    expect(
      [...screen.getByLabelText("Messaging surface").querySelectorAll("option")]
        .map((option) => option.textContent),
    ).toEqual([
      "Choose a recently seen surface...",
      "Enter an ID manually...",
    ]);

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "conversation" },
    });
    fireEvent.change(screen.getByLabelText("Messaging surface"), {
      target: {
        value: JSON.stringify([
          "conversation",
          "slack",
          "channel",
          "",
          "C0BN6UXFREE",
        ]),
      },
    });
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["codex", "agent-1"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C0BN6UXFREE",
            kind: "channel",
            title: "p-pwragent-testing",
            workspaceId: "T1",
          },
        },
        target: { backend: "codex", threadId: "agent-1" },
      });
    });
  });

  it("labels an existing parent route as a child thread or topic default", async () => {
    const routes = buildRoutes();
    routes.defaultAgents = [{
      ...routes.defaultAgents[0]!,
      scope: {
        kind: "parent",
        platform: "slack",
        conversationId: "C13056",
      },
    }];
    routes.bindings = [];
    const { desktopApi } = buildDesktopApi(routes);

    renderRoutes(desktopApi);

    expect(
      await screen.findByText(/Child thread\/topic default/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Parent default/)).not.toBeInTheDocument();
  });

  it("offers only messaging platforms configured for this instance", async () => {
    const api = buildDesktopApi();
    renderRoutes(
      api.desktopApi,
      undefined,
      ["telegram", "mattermost", "line"],
    );
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));

    const platformSelect = screen.getByLabelText("Messaging platform");
    expect(platformSelect).toHaveValue("telegram");
    expect(
      [...platformSelect.querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["Telegram", "Mattermost", "LINE"]);
  });

  it("keeps profile defaults available without a configured platform", async () => {
    const api = buildDesktopApi();
    renderRoutes(api.desktopApi, undefined, []);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));

    expect(screen.getByLabelText("Default scope")).toHaveValue("profile");
    expect(screen.queryByLabelText("Messaging platform")).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Conversation" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "PwrAgent profile" }),
    ).toBeEnabled();
  });

  it("orders observed surfaces by recency and derives parent and workspace choices", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces.push({
      platform: "slack",
      conversation: {
        id: "C13056",
        kind: "thread",
        parentId: "1700000000.000100",
        parentConversationId: "C13056",
        parentTitle: "p-search-signals-project",
        title: "13056 investigation",
        workspaceId: "T1",
      },
      firstSeenAt: 2500,
      lastSeenAt: 3000,
    });
    const api = buildDesktopApi(routes);
    renderRoutes(api.desktopApi);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    const surfaceSelect = screen.getByLabelText("Messaging surface");
    expect(
      [...surfaceSelect.querySelectorAll("option")].map((option) => option.textContent),
    ).toEqual([
      "Choose a recently seen surface...",
      expect.stringContaining("13056 investigation"),
      expect.stringContaining("p-search-signals-project"),
      expect.stringContaining("archived-project"),
      "Enter an ID manually...",
    ]);

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "parent" },
    });
    expect(
      [...screen.getByLabelText("Messaging surface").querySelectorAll("option")]
        .map((option) => option.textContent),
    ).toEqual([
      "Choose a recently seen surface...",
      expect.stringContaining("Slack / p-search-signals-project"),
      "Enter an ID manually...",
    ]);

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "workspace" },
    });
    expect(screen.getByLabelText("Messaging surface")).toHaveTextContent(
      "Slack / T1",
    );
  });

  it("keeps manual IDs as an explicit fallback", async () => {
    const api = buildDesktopApi();
    renderRoutes(api.desktopApi);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    expect(screen.queryByLabelText("Conversation ID")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Messaging surface"), {
      target: { value: "manual" },
    });
    fireEvent.change(screen.getByLabelText("Conversation ID"), {
      target: { value: "C200" },
    });
    fireEvent.change(screen.getByLabelText("Display name (optional)"), {
      target: { value: "incident-response" },
    });
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["codex", "agent-1"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C200",
            kind: "channel",
            title: "incident-response",
          },
        },
        target: { backend: "codex", threadId: "agent-1" },
      });
    });
  });

  it("retargets and clears defaults and unbinds conversations", async () => {
    const api = buildDesktopApi();
    renderRoutes(api.desktopApi);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["acp:grok", "agent-2"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          assignmentId: "assignment-1",
          target: { backend: "acp:grok", threadId: "agent-2" },
        }),
      );
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Clear" })[0]!);
    await waitFor(() => {
      expect(api.clearMessagingDefaultAgent).toHaveBeenCalledWith({
        assignmentId: "assignment-1",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    await waitFor(() => {
      expect(api.unbindMessagingThread).toHaveBeenCalledWith({
        bindingId: "binding-1",
      });
    });
  });
});
