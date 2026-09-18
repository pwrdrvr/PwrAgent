import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendKind,
  DesktopAuthorizedContact,
  DesktopMessagingObservedSurface,
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

/** The trigger's accessible name is always "Surface: <whatever it shows>",
 *  so one regex finds it whether or not a destination is chosen. */
function surfaceTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Surface: / });
}

function openSurfacePicker() {
  fireEvent.click(surfaceTrigger());
}

function surfaceOptions(): HTMLElement[] {
  return within(screen.getByRole("listbox")).getAllByRole("option");
}

function chooseSurface(label: string) {
  openSurfacePicker();
  fireEvent.click(screen.getByRole("option", { name: new RegExp(label) }));
}

/** The Discord response-mode ADD picker. Its value never changes, so its
 *  accessible name is "Add a channel or thread: <placeholder>". */
function addTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Add a channel or thread: / });
}

/** Focus first: it is the only way jsdom reproduces the focus move a real
 *  click makes, and a panel that closed in the frame it opened once passed
 *  every test that skipped it. */
function openAddPicker() {
  const trigger = addTrigger();
  trigger.focus();
  fireEvent.click(trigger);
}

/** Row names as the operator reads them, without the ID and date columns. */
function addPickerNames(): Array<string | null | undefined> {
  return within(screen.getByRole("listbox"))
    .queryAllByRole("option")
    .map((option) => option.querySelector(".project-picker__row-name")?.textContent);
}

function addPickerSections(): Array<string | null> {
  return within(screen.getByRole("listbox"))
    .queryAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
}

/** Invented Discord surfaces with obviously fake IDs. */
function discordSurface(
  conversation: DesktopMessagingObservedSurface["conversation"],
  lastSeenAt: number,
): DesktopMessagingObservedSurface {
  return {
    platform: "discord",
    conversation: { workspaceId: "2222222222222222222", ...conversation },
    firstSeenAt: 1000,
    lastSeenAt,
  };
}

function buildRoutes(): ListMessagingRoutesResponse {
  return {
    eligibleAgents: [
      {
        backend: "codex",
        threadId: "agent-1",
        label: "Orchard Agent",
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
            id: "C_ORCHARD",
            kind: "channel",
            title: "orchard-planning",
            workspaceId: "T1",
          },
        },
        target: {
          backend: "codex",
          threadId: "agent-1",
          label: "Orchard Agent",
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
          title: "Fictional harvest discussion",
          parentTitle: "orchard-planning",
        },
        target: {
          backend: "codex",
          backendLabel: "Codex",
          backendAvailable: true,
          threadId: "work-1",
          label: "Harvest task",
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
          id: "C_ORCHARD",
          kind: "channel",
          title: "orchard-planning",
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

    const { rerender } = render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{ source: "config", value: [], onSave }}
        />
      </MessagingRoutesProvider>,
    );

    // The picker offers the observed channel by name. An operator never types
    // a snowflake to set response behavior.
    await screen.findByRole("button", {
      name: "Add a channel or thread: Select a channel or thread...",
    });
    openAddPicker();
    expect(addPickerNames()).toEqual(["Discord / Test server / general"]);
    fireEvent.click(screen.getByRole("option", {
      name: /^Discord \/ Test server \/ general/,
    }));

    const saved = [
      {
        id: "1480556454498009352",
        displayName: "general",
        responseMode: "mention_only" as const,
      },
    ];
    expect(onSave).toHaveBeenCalledWith(saved);
    // Admission and routing are independent: choosing when to respond must not
    // assign, clear, or otherwise disturb a default Agent.
    expect(api.setMessagingDefaultAgent).not.toHaveBeenCalled();
    expect(api.clearMessagingDefaultAgent).not.toHaveBeenCalled();

    // The component is controlled, so re-render with what the save produced:
    // the surface becomes a row and leaves the "add" list.
    rerender(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{ source: "config", value: saved, onSave }}
        />
      </MessagingRoutesProvider>,
    );

    expect(addTrigger()).toHaveAccessibleName(
      "Add a channel or thread: No unconfigured Discord channels seen yet",
    );
    const rowMode = screen.getByRole("combobox", {
      name: "Responds to for Discord / Test server / general",
    });
    expect(rowMode).toHaveValue("mention_only");

    // "Default" has to be reachable, or a row can never be returned to
    // inheriting its server's setting once it has been given one.
    onSave.mockClear();
    fireEvent.change(rowMode, { target: { value: "" } });
    expect(onSave).toHaveBeenCalledWith([
      { id: "1480556454498009352", displayName: "general" },
    ]);
  });

  it("edits one of two rows that share an ID", async () => {
    // `response_mode_overrides` is a plain array and nothing dedupes it; the
    // raw-ID editor this replaced could persist the same snowflake twice.
    // Matching by ID would delete or rewrite both rows.
    const api = buildDesktopApi();
    const onSave = vi.fn();
    const duplicated = [
      {
        id: "1480556454498009352",
        displayName: "first",
        responseMode: "mention_only" as const,
      },
      {
        id: "1480556454498009352",
        displayName: "second",
        responseMode: "every_message" as const,
      },
    ];

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{
            source: "config",
            value: duplicated,
            onSave,
          }}
        />
      </MessagingRoutesProvider>,
    );

    const removes = await screen.findAllByRole("button", {
      name: "Remove response behavior for second",
    });
    fireEvent.click(removes[0]!);

    expect(onSave).toHaveBeenCalledWith([duplicated[0]]);
  });

  it("does not label a channel with its server name when the parent lookup failed", async () => {
    // The adapter sets `parentTitle` to `parentChannelName ?? guildName`, and
    // marks a resolved parent by also setting `ancestorTitle`. Without that
    // marker the name in hand is the server's, so the picker must fall back to
    // the ID rather than offer a channel that reads as the whole server.
    const routes = buildRoutes();
    routes.observedSurfaces.push({
      platform: "discord",
      conversation: {
        id: "1480556454498009400",
        kind: "thread",
        title: "bugfix",
        parentConversationId: "1480556454498009352",
        parentTitle: "Test server",
        workspaceId: "1480556454498009353",
      },
      firstSeenAt: 1000,
      lastSeenAt: 3000,
    });
    const api = buildDesktopApi(routes);

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{ source: "config", value: [], onSave: vi.fn() }}
        />
      </MessagingRoutesProvider>,
    );

    await screen.findByRole("button", {
      name: "Add a channel or thread: Select a channel or thread...",
    });
    openAddPicker();
    expect(addPickerNames()).not.toContain("Discord / Test server");
    expect(addPickerNames()).toContain("Discord / 1480556454498009352");
  });

  it("offers native threads under their own heading, with no manual row", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces.push(
      discordSurface({
        id: "1111111111111111111",
        kind: "channel",
        title: "orchard-planning",
        ancestorTitle: "Orchard Collective",
      }, 5000),
      discordSurface({
        id: "1111111111111111121",
        kind: "thread",
        title: "Cider press schedule",
        parentConversationId: "1111111111111111111",
        parentTitle: "orchard-planning",
        ancestorTitle: "Orchard Collective",
      }, 4000),
    );
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

    await screen.findByRole("button", {
      name: "Add a channel or thread: Select a channel or thread...",
    });
    openAddPicker();
    // A native thread's own setting beats its parent channel's, so the list
    // must keep threads: the default-route filter drops them.
    expect(addPickerSections()).toEqual(["Channels", "Native threads"]);
    expect(
      within(screen.getByRole("group", { name: "Native threads" }))
        .getByRole("option", { name: /Cider press schedule/ }),
    ).toHaveTextContent("1111111111111111121");
    expect(screen.getByRole("combobox", { name: "Find a channel or thread" })).toHaveFocus();
    // This list replaced a raw-ID editor on purpose, and `addSurface` has
    // no candidate for a typed ID, so the action would silently do nothing.
    expect(screen.queryByRole("button", { name: /manually/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Cider press schedule/ }));
    expect(onSave).toHaveBeenCalledWith([{
      id: "1111111111111111121",
      displayName: "Cider press schedule",
      responseMode: "mention_only",
    }]);
  });

  it("returns the add picker to its placeholder, focused, after each add", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces.push(
      discordSurface({
        id: "1111111111111111111",
        kind: "channel",
        title: "orchard-planning",
        ancestorTitle: "Orchard Collective",
      }, 5000),
      discordSurface({
        id: "1111111111111111112",
        kind: "channel",
        title: "harvest-log",
        ancestorTitle: "Orchard Collective",
      }, 4000),
    );
    const api = buildDesktopApi(routes);
    const onSave = vi.fn();
    const renderSection = (
      value: DesktopAuthorizedContact[],
      disabled = false,
    ) => (
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{ disabled, source: "config", value, onSave }}
        />
      </MessagingRoutesProvider>
    );

    const { rerender } = render(renderSection([]));
    await screen.findByRole("button", {
      name: "Add a channel or thread: Select a channel or thread...",
    });
    openAddPicker();
    fireEvent.click(screen.getByRole("option", { name: /orchard-planning/ }));
    const saved = onSave.mock.calls[0]![0] as DesktopAuthorizedContact[];
    expect(saved.map((entry) => entry.id)).toEqual(["1111111111111111111"]);

    // Settings disables the section while that pick saves. The trigger has
    // to survive it holding focus, or the operator loses their place on
    // every add.
    rerender(renderSection(saved, true));
    expect(addTrigger()).toHaveAttribute("aria-disabled", "true");
    expect(addTrigger()).toHaveFocus();
    rerender(renderSection(saved));

    // An add picker, not a value picker: nothing stays "selected", and the
    // surface just added has left the list.
    expect(addTrigger()).toHaveAccessibleName(
      "Add a channel or thread: Select a channel or thread...",
    );
    expect(addTrigger()).toHaveFocus();
    openAddPicker();
    expect(addPickerNames()).toEqual(["Discord / Orchard Collective / harvest-log"]);
  });

  it("disables the add picker while loading and when every surface is configured", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces.push(discordSurface({
      id: "1111111111111111111",
      kind: "channel",
      title: "orchard-planning",
      ancestorTitle: "Orchard Collective",
    }, 5000));
    let finishLoading: (value: ListMessagingRoutesResponse) => void = () => {};
    const api = buildDesktopApi(routes);
    api.listMessagingRoutes.mockImplementation(() => new Promise((resolve) => {
      finishLoading = resolve;
    }));

    render(
      <MessagingRoutesProvider desktopApi={api.desktopApi}>
        <MessagingRoutesSettings
          desktopApi={api.desktopApi}
          discordResponseBehavior={{
            source: "config",
            value: [{ id: "1111111111111111111", displayName: "orchard-planning" }],
            onSave: vi.fn(),
          }}
        />
      </MessagingRoutesProvider>,
    );

    expect(addTrigger()).toHaveAccessibleName(
      "Add a channel or thread: Loading channels...",
    );
    expect(addTrigger()).toHaveAttribute("aria-disabled", "true");
    openAddPicker();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    finishLoading(routes);
    await screen.findByRole("button", {
      name: "Add a channel or thread: No unconfigured Discord channels seen yet",
    });
    expect(addTrigger()).toHaveAttribute("aria-disabled", "true");
    openAddPicker();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
      await screen.findByText("Slack / orchard-planning"),
    ).toBeInTheDocument();
    expect(screen.getByText("Orchard Agent")).toBeInTheDocument();
    expect(screen.getByText("Missing unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Fictional harvest discussion/)).toBeInTheDocument();
    expect(screen.getByText("Harvest task")).toBeInTheDocument();
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
    await screen.findByText("Harvest task");

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Orchard Agent" }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "agent-1",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Harvest task" }),
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
          id="C_ORCHARD"
          label="Channel default Agent"
          platform="slack"
          scopeKind="conversation"
          title="orchard-planning"
        />
        <MessagingRoutesSettings desktopApi={api.desktopApi} />
      </MessagingRoutesProvider>,
    );

    expect(await screen.findByText("Channel default Agent")).toBeInTheDocument();
    expect(screen.getAllByText("Orchard Agent")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Change default Agent for orchard-planning",
      }),
    );

    expect(screen.getByText("Change default Agent")).toBeInTheDocument();
    expect(
      screen.getAllByText("Slack / orchard-planning"),
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
    expect(surfaceTrigger()).toHaveTextContent("Slack / incident-response");
    openSurfacePicker();
    const configuredGroup = within(screen.getByRole("listbox")).getByRole(
      "group",
      { name: "Current configuration" },
    );
    expect(configuredGroup).toBeInTheDocument();
    // The route's own destination is the row the operator most needs to
    // identify, and it was the only one rendering without its identifier.
    expect(within(configuredGroup).getByRole("option").textContent).toContain(
      "C200",
    );
    fireEvent.keyDown(screen.getByLabelText("Find a surface"), { key: "Escape" });
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
    await screen.findByText("Orchard Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    chooseSurface("Slack / orchard-planning");
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
            id: "C_ORCHARD",
            kind: "channel",
            title: "orchard-planning",
            workspaceId: "T1",
          },
        },
        target: { backend: "acp:grok", threadId: "agent-2" },
      });
    });
  });

  it("dates a stale surface by year and the saved route by its ID", async () => {
    const routes = buildRoutes();
    const thisYear = new Date();
    thisYear.setMonth(0, 15);
    routes.observedSurfaces = [
      {
        platform: "slack",
        conversation: { id: "C_FRESH", kind: "channel", title: "fresh-channel", workspaceId: "T1" },
        firstSeenAt: 1000,
        lastSeenAt: thisYear.getTime(),
      },
      {
        platform: "slack",
        conversation: { id: "C_STALE", kind: "channel", title: "stale-channel", workspaceId: "T1" },
        firstSeenAt: 1000,
        // Mid-month, mid-year so no timezone can shift it across a year
        // boundary. Without the year this reads as the same recency as the
        // row above it.
        lastSeenAt: new Date(2020, 5, 15, 12).getTime(),
      },
    ];
    const api = buildDesktopApi(routes);
    renderRoutes(api.desktopApi);
    await screen.findByText("Orchard Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    openSurfacePicker();
    const rows = Object.fromEntries(
      surfaceOptions().map((option) => [option.textContent ?? "", option]),
    );
    const stale = Object.keys(rows).find((text) => text.includes("stale-channel"));
    const fresh = Object.keys(rows).find((text) => text.includes("fresh-channel"));
    expect(stale).toContain("2020");
    expect(fresh).not.toContain(String(new Date().getFullYear()));
  });

  it("routes a selected Slack channel as an exact conversation, not a parent fallback", async () => {
    const routes = buildRoutes();
    routes.defaultAgents = [];
    routes.bindings = [];
    routes.observedSurfaces = [
      {
        platform: "slack",
        conversation: {
          id: "C_MEADOW",
          kind: "channel",
          title: "meadow-testing",
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
    openSurfacePicker();
    expect(screen.getByText("No matching surfaces.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Find a surface"), { key: "Escape" });

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "conversation" },
    });
    chooseSurface("Slack / meadow-testing");
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
            id: "C_MEADOW",
            kind: "channel",
            title: "meadow-testing",
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
        conversationId: "C_ORCHARD",
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
    await screen.findByText("Orchard Agent");

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
    await screen.findByText("Orchard Agent");

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
        id: "C_ORCHARD",
        kind: "thread",
        parentId: "1700000000.000100",
        parentConversationId: "C_ORCHARD",
        parentTitle: "orchard-planning",
        title: "Fictional harvest discussion",
        workspaceId: "T1",
      },
      firstSeenAt: 2500,
      lastSeenAt: 3000,
    });
    const api = buildDesktopApi(routes);
    renderRoutes(api.desktopApi);
    await screen.findByText("Orchard Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    openSurfacePicker();
    expect(surfaceOptions().map((option) => option.textContent)).toEqual([
      expect.stringContaining("orchard-planning"),
      expect.stringContaining("archived-project"),
    ]);
    expect(screen.queryByRole("option", { name: /Fictional harvest discussion/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Threads / topics" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "parent" },
    });
    openSurfacePicker();
    expect(screen.getByRole("option", { name: /Slack \/ orchard-planning/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Default scope"), {
      target: { value: "workspace" },
    });
    openSurfacePicker();
    expect(screen.getByRole("option", { name: /Slack \/ T1/ })).toBeInTheDocument();
  });

  it("selects durable Telegram topics with their group identity and excludes reply threads", async () => {
    const routes = buildRoutes();
    routes.observedSurfaces = [
      {
        platform: "telegram",
        conversation: { id: "42", kind: "topic", parentId: "-100900", parentConversationId: "-100900", title: "Garden plans" },
        firstSeenAt: 1000,
        lastSeenAt: 2000,
      },
      {
        platform: "telegram",
        conversation: { id: "99", kind: "thread", title: "Ephemeral reply" },
        firstSeenAt: 1000,
        lastSeenAt: 3000,
      },
    ];
    const api = buildDesktopApi(routes);
    renderRoutes(api.desktopApi, undefined, ["telegram"]);
    await screen.findByText("Orchard Agent");
    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    openSurfacePicker();
    // A named forum topic is a durable destination, so it gets its own section
    // rather than hiding behind a Telegram-only filter. A reply thread is not.
    expect(
      within(screen.getByRole("listbox")).getByRole("group", { name: "Telegram topics" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ephemeral reply/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Garden plans/ }));
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["codex", "agent-1"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
      scope: {
        kind: "conversation",
        platform: "telegram",
        conversation: { id: "42", kind: "topic", parentId: "-100900", parentConversationId: "-100900", title: "Garden plans" },
      },
      target: { backend: "codex", threadId: "agent-1" },
    }));
  });

  it("keeps manual IDs as an explicit fallback", async () => {
    const api = buildDesktopApi();
    renderRoutes(api.desktopApi);
    await screen.findByText("Orchard Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    expect(screen.queryByLabelText("Conversation ID")).not.toBeInTheDocument();
    openSurfacePicker();
    fireEvent.click(screen.getByRole("button", { name: "Enter an ID manually..." }));
    expect(screen.queryByRole("option", { name: "Thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Telegram topic" })).not.toBeInTheDocument();
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
    await screen.findByText("Orchard Agent");

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
