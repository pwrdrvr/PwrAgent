import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppServerBackendKind,
  DesktopAuthorizedContact,
  DesktopMessagingAgentRouteTarget,
  DesktopMessagingDefaultAgentRoute,
  DesktopMessagingDefaultAgentScope,
  DesktopMessagingObservedSurface,
  DesktopMessagingResponseMode,
  ListMessagingRoutesResponse,
  MessagingChannelKind,
  MessagingConversationKind,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import { PlusIcon } from "../../icons";
import {
  MESSAGING_PLATFORM_ICONS,
  formatMessagingPlatformName,
} from "../../lib/messaging-platform-branding";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSection } from "./SettingsLayout";
import { RESPONSE_MODE_OPTIONS, responseModeTitle } from "./settings-fields";

const EMPTY_ROUTES: ListMessagingRoutesResponse = {
  defaultAgents: [],
  bindings: [],
  eligibleAgents: [],
  observedSurfaces: [],
};

const ROUTE_PLATFORMS: MessagingChannelKind[] = [
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "feishu",
  "line",
];

const ROUTE_TOOL_UPDATE_MODE_OPTIONS: Array<{
  label: string;
  value: MessagingToolUpdateMode;
}> = [
  { label: "Show None", value: "show_none" },
  { label: "Show Less", value: "show_less" },
  { label: "Show Some", value: "show_some" },
  { label: "Show More", value: "show_more" },
  { label: "Show All", value: "show_all" },
];

type DefaultScopeKind = DesktopMessagingDefaultAgentScope["kind"];

type NewDefaultForm = {
  scopeKind: DefaultScopeKind;
  platform: MessagingChannelKind;
  workspaceId: string;
  parentConversationId: string;
  conversationId: string;
  conversationKind: MessagingConversationKind;
  identityParentId: string;
  title: string;
};

const EMPTY_FORM: NewDefaultForm = {
  scopeKind: "conversation",
  platform: "slack",
  workspaceId: "",
  parentConversationId: "",
  conversationId: "",
  conversationKind: "channel",
  identityParentId: "",
  title: "",
};

type RouteEditorRequest =
  | {
      id: number;
      assignment: DesktopMessagingDefaultAgentRoute;
    }
  | {
      id: number;
      initialForm: NewDefaultForm;
    };

type MessagingRoutesContextValue = {
  routes: ListMessagingRoutesResponse;
  loading: boolean;
  error: string | null;
  editorRequest: RouteEditorRequest | null;
  loadRoutes: () => Promise<void>;
  openAssignment: (assignment: DesktopMessagingDefaultAgentRoute) => void;
  openNewAssignment: (initialForm: NewDefaultForm) => void;
};

const MessagingRoutesContext = createContext<MessagingRoutesContextValue | null>(
  null,
);

export function MessagingRoutesProvider(props: {
  children: ReactNode;
  desktopApi?: DesktopApi;
}) {
  const [routes, setRoutes] = useState<ListMessagingRoutesResponse>(EMPTY_ROUTES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorRequest, setEditorRequest] = useState<RouteEditorRequest | null>(
    null,
  );
  const requestIdRef = useRef(0);

  const loadRoutes = useCallback(async () => {
    if (!props.desktopApi?.listMessagingRoutes) {
      setLoading(false);
      setError("Messaging route management is unavailable in this app build.");
      return;
    }
    try {
      const next = await props.desktopApi.listMessagingRoutes();
      setRoutes(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadRoutes();
    return props.desktopApi?.onMessagingBindingsChanged?.(() => {
      void loadRoutes();
    });
  }, [loadRoutes, props.desktopApi]);

  const value = useMemo<MessagingRoutesContextValue>(
    () => ({
      routes,
      loading,
      error,
      editorRequest,
      loadRoutes,
      openAssignment: (assignment) => {
        requestIdRef.current += 1;
        setEditorRequest({ id: requestIdRef.current, assignment });
      },
      openNewAssignment: (initialForm) => {
        requestIdRef.current += 1;
        setEditorRequest({ id: requestIdRef.current, initialForm });
      },
    }),
    [editorRequest, error, loadRoutes, loading, routes],
  );

  return (
    <MessagingRoutesContext.Provider value={value}>
      {props.children}
    </MessagingRoutesContext.Provider>
  );
}

function useMessagingRoutes(): MessagingRoutesContextValue {
  const value = useContext(MessagingRoutesContext);
  if (!value) {
    throw new Error("Messaging route controls require MessagingRoutesProvider.");
  }
  return value;
}

export function MessagingRoutesSettings(props: {
  agentRouteToolUpdateMode?: MessagingToolUpdateMode;
  configuredPlatforms?: readonly MessagingChannelKind[];
  desktopApi?: DesktopApi;
  discordResponseBehavior?: Omit<
    DiscordResponseBehaviorProps,
    "loading" | "observedSurfaces"
  >;
  onOpenThread?: (target: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void;
}) {
  const routeState = useMessagingRoutes();
  const { routes, loading, loadRoutes } = routeState;
  const agentRouteToolUpdateMode =
    props.agentRouteToolUpdateMode ?? "show_none";
  const configuredPlatforms = props.configuredPlatforms ?? ROUTE_PLATFORMS;
  const emptyForm = props.configuredPlatforms
    ? newDefaultForm(configuredPlatforms)
    : EMPTY_FORM;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [initialForm, setInitialForm] = useState<NewDefaultForm>(emptyForm);
  const [editing, setEditing] = useState<DesktopMessagingDefaultAgentRoute | null>(
    null,
  );
  const routesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const request = routeState.editorRequest;
    if (!request) return;
    if ("assignment" in request) {
      setShowAdd(false);
      setEditing(request.assignment);
    } else {
      setEditing(null);
      setInitialForm(request.initialForm);
      setShowAdd(true);
    }
    routesRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [routeState.editorRequest]);

  const clearDefault = async (assignmentId: string) => {
    if (!props.desktopApi?.clearMessagingDefaultAgent) return;
    setBusyId(assignmentId);
    try {
      await props.desktopApi.clearMessagingDefaultAgent({ assignmentId });
      if (editing?.assignmentId === assignmentId) setEditing(null);
      await loadRoutes();
    } catch (mutationError) {
      setMutationError(
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError),
      );
    } finally {
      setBusyId(null);
    }
  };

  const unbind = async (bindingId: string) => {
    if (!props.desktopApi?.unbindMessagingThread) return;
    setBusyId(bindingId);
    try {
      await props.desktopApi.unbindMessagingThread({ bindingId });
      await loadRoutes();
    } catch (mutationError) {
      setMutationError(
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError),
      );
    } finally {
      setBusyId(null);
    }
  };

  const routeCount = routes.defaultAgents.length + routes.bindings.length;

  return (
    <SettingsSection
      eyebrow="Messaging"
      title="Routes"
      description="Manage persistent defaults and active messaging bindings from one place."
      chip={`${routeCount} active`}
      chipKind={routeCount > 0 ? "ok" : "muted"}
    >
      <div className="messaging-routes" ref={routesRef}>
        <div className="messaging-routes__toolbar">
          <div>
            <strong>Default Agents</strong>
            <span>
              Choose which Agent receives messages PwrAgent handles on unbound surfaces.
            </span>
          </div>
          <button
            className="button button--secondary messaging-routes__add"
            disabled={
              loading
              || routes.eligibleAgents.length === 0
              || !props.desktopApi?.setMessagingDefaultAgent
            }
            type="button"
            onClick={() => {
              setEditing(null);
              setInitialForm(emptyForm);
              setShowAdd((current) => !current);
            }}
          >
            <PlusIcon size={14} />
            Add default
          </button>
        </div>

        {mutationError ?? routeState.error ? (
          <p className="messaging-routes__error" role="alert">
            {mutationError ?? routeState.error}
          </p>
        ) : null}

        {showAdd ? (
          <DefaultAgentEditor
            key={`add:${routeState.editorRequest?.id ?? "manual"}`}
            agents={routes.eligibleAgents}
            initialForm={initialForm}
            observedSurfaces={routes.observedSurfaces ?? []}
            platforms={platformsForForm(configuredPlatforms, initialForm)}
            onCancel={() => setShowAdd(false)}
            onSaved={async () => {
              setShowAdd(false);
              setMutationError(null);
              await loadRoutes();
            }}
            desktopApi={props.desktopApi}
            inheritedToolUpdateMode={agentRouteToolUpdateMode}
          />
        ) : null}

        {editing ? (
          <DefaultAgentEditor
            key={`edit:${editing.assignmentId}`}
            agents={routes.eligibleAgents}
            assignment={editing}
            observedSurfaces={routes.observedSurfaces ?? []}
            platforms={configuredPlatforms}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              setMutationError(null);
              await loadRoutes();
            }}
            desktopApi={props.desktopApi}
            inheritedToolUpdateMode={agentRouteToolUpdateMode}
          />
        ) : null}

        <div className="messaging-routes__list" aria-label="Default Agent routes">
          {loading ? (
            <p className="messaging-routes__empty">Loading routes...</p>
          ) : routes.defaultAgents.length === 0 ? (
            <p className="messaging-routes__empty">No default Agents configured.</p>
          ) : (
            routes.defaultAgents.map((route) => (
              <DefaultAgentRow
                key={route.assignmentId}
                route={route}
                busy={busyId === route.assignmentId}
                onChange={() => {
                  setShowAdd(false);
                  setEditing(route);
                }}
                onClear={() => void clearDefault(route.assignmentId)}
                onOpenThread={props.onOpenThread}
              />
            ))
          )}
        </div>

        {props.discordResponseBehavior ? (
          <DiscordResponseBehavior
            {...props.discordResponseBehavior}
            loading={loading}
            observedSurfaces={routes.observedSurfaces ?? []}
          />
        ) : null}

        <div className="messaging-routes__subhead">
          <strong>Active bindings</strong>
          <span>Conversations currently attached to PwrAgent threads.</span>
        </div>
        <div className="messaging-routes__list" aria-label="Active messaging bindings">
          {loading ? (
            <p className="messaging-routes__empty">Loading bindings...</p>
          ) : routes.bindings.length === 0 ? (
            <p className="messaging-routes__empty">No active bindings.</p>
          ) : (
            routes.bindings.map((binding) => {
              const Icon = MESSAGING_PLATFORM_ICONS[binding.platform];
              const backend = binding.target.backend;
              const onOpenThread = props.onOpenThread;
              const openTarget = backend && onOpenThread
                ? () => onOpenThread({
                    backend,
                    threadId: binding.target.threadId,
                  })
                : undefined;
              return (
                <div className="messaging-route-row" key={binding.bindingId}>
                  <button
                    aria-label={`Open thread ${binding.target.label}`}
                    className="messaging-route-row__open"
                    disabled={!openTarget}
                    title={openTarget ? `Open ${binding.target.label}` : undefined}
                    type="button"
                    onClick={openTarget}
                  >
                    <div className="messaging-route-row__platform" aria-hidden="true">
                      {Icon ? <Icon size={16} /> : null}
                    </div>
                    <div className="messaging-route-row__main">
                      <div className="messaging-route-row__title">
                        {formatConversationLabel(binding.platform, binding.conversation)}
                      </div>
                      <div className="messaging-route-row__meta">
                        {formatMessagingPlatformName(binding.platform)}
                        {" / "}
                        {formatConversationKind(binding.conversation.kind)}
                        {" / "}
                        {binding.target.kind === "agent_thread" ? "Agent" : "Thread"}
                      </div>
                    </div>
                    <div className="messaging-route-row__target">
                      <span className="messaging-route-row__target-title">
                        {binding.target.label}
                      </span>
                      <div className="messaging-route-row__target-meta">
                        <ProviderChip
                          available={binding.target.backendAvailable === true}
                          label={binding.target.backendLabel ?? "Unknown provider"}
                        />
                        <code>{binding.target.threadId}</code>
                      </div>
                    </div>
                  </button>
                  <div className="messaging-route-row__actions">
                    <button
                      className="button button--ghost"
                      disabled={busyId === binding.bindingId}
                      type="button"
                      onClick={() => void unbind(binding.bindingId)}
                    >
                      {busyId === binding.bindingId ? "Unbinding..." : "Unbind"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function DefaultAgentRow(props: {
  route: DesktopMessagingDefaultAgentRoute;
  busy: boolean;
  onChange: () => void;
  onClear: () => void;
  onOpenThread?: (target: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void;
}) {
  const platform = platformForScope(props.route.scope);
  const Icon = platform ? MESSAGING_PLATFORM_ICONS[platform] : undefined;
  const toolUpdateOverride = props.route.toolUpdateMode
    ? routeToolUpdateModeLabel(props.route.toolUpdateMode)
    : undefined;
  return (
    <div className="messaging-route-row">
      <button
        aria-label={[
          `Open thread ${props.route.target.label}`,
          toolUpdateOverride
            ? `Working Updates override ${toolUpdateOverride}`
            : undefined,
        ].filter(Boolean).join(", ")}
        className="messaging-route-row__open"
        disabled={!props.onOpenThread}
        title={props.onOpenThread ? `Open ${props.route.target.label}` : undefined}
        type="button"
        onClick={() => props.onOpenThread?.({
          backend: props.route.target.backend,
          threadId: props.route.target.threadId,
        })}
      >
        <div className="messaging-route-row__platform" aria-hidden="true">
          {Icon ? <Icon size={16} /> : <span className="messaging-route-row__profile">P</span>}
        </div>
        <div className="messaging-route-row__main">
          <div className="messaging-route-row__title">
            {formatScopeLabel(props.route.scope)}
          </div>
          <div className="messaging-route-row__meta">
            {formatScopeKind(props.route.scope.kind)}
            {" / Updated "}
            {formatTimestamp(props.route.updatedAt)}
          </div>
        </div>
        <div className="messaging-route-row__target">
          <span className="messaging-route-row__target-title">
            {props.route.target.label}
          </span>
          <div className="messaging-route-row__target-meta">
            <ProviderChip
              available={props.route.target.backendAvailable}
              label={props.route.target.backendLabel}
            />
            {toolUpdateOverride ? (
              <span
                className="chip chip--backend messaging-route-row__provider-chip"
                title={`Working Updates override: ${toolUpdateOverride}`}
              >
                Updates: {toolUpdateOverride}
              </span>
            ) : null}
            {!props.route.target.available
              && props.route.target.backendAvailable ? (
                <span className="messaging-route-row__target-warning">
                  Agent unavailable
                </span>
              ) : null}
          </div>
        </div>
      </button>
      <div className="messaging-route-row__actions">
        <button
          className="button button--secondary"
          disabled={props.busy}
          type="button"
          onClick={props.onChange}
        >
          Change
        </button>
        <button
          className="button button--ghost"
          disabled={props.busy}
          type="button"
          onClick={props.onClear}
        >
          {props.busy ? "Clearing..." : "Clear"}
        </button>
      </div>
    </div>
  );
}

function ProviderChip(props: { available: boolean; label: string }) {
  return (
    <span
      className={`chip chip--backend messaging-route-row__provider-chip${
        props.available ? "" : " is-stale"
      }`}
    >
      {props.label}{props.available ? "" : " unavailable"}
    </span>
  );
}

export function ApprovedSurfaceDefaultAgent(props: {
  disabled?: boolean;
  id: string;
  label: string;
  platform: MessagingChannelKind;
  scopeKind: "conversation" | "parent" | "workspace";
  title?: string;
}) {
  const routeState = useMessagingRoutes();
  const assignment = findApprovedSurfaceAssignment(
    routeState.routes.defaultAgents,
    props,
  );
  const canOpen =
    !props.disabled
    && !routeState.loading
    && !routeState.error
    && (Boolean(assignment) || routeState.routes.eligibleAgents.length > 0);
  const surfaceLabel = props.title?.trim() || props.id;

  return (
    <div className="settings-authorized-list__default-agent">
      <span className="settings-authorized-list__default-agent-label">
        {props.label}
      </span>
      {assignment ? (
        <>
          <strong>{assignment.target.label}</strong>
          <ProviderChip
            available={assignment.target.backendAvailable}
            label={assignment.target.backendLabel}
          />
        </>
      ) : (
        <span className="settings-authorized-list__default-agent-empty">
          {routeState.loading
            ? "Checking..."
            : routeState.error
              ? "Status unavailable"
              : "No direct default"}
        </span>
      )}
      <button
        aria-label={`${assignment ? "Change" : "Assign"} default Agent for ${surfaceLabel}`}
        className="button button--ghost settings-authorized-list__default-agent-action"
        disabled={!canOpen}
        type="button"
        onClick={() => {
          if (assignment) {
            routeState.openAssignment(assignment);
            return;
          }
          routeState.openNewAssignment(
            approvedSurfaceInitialForm(props),
          );
        }}
      >
        {routeState.loading ? "Checking..." : assignment ? "Change" : "Assign"}
      </button>
    </div>
  );
}

function DefaultAgentEditor(props: {
  agents: DesktopMessagingAgentRouteTarget[];
  assignment?: DesktopMessagingDefaultAgentRoute;
  desktopApi?: DesktopApi;
  inheritedToolUpdateMode: MessagingToolUpdateMode;
  initialForm?: NewDefaultForm;
  observedSurfaces: DesktopMessagingObservedSurface[];
  platforms: readonly MessagingChannelKind[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<NewDefaultForm>(
    props.initialForm ?? EMPTY_FORM,
  );
  const [surfaceSelection, setSurfaceSelection] = useState(() =>
    surfaceSelectionForForm(
      props.observedSurfaces,
      props.initialForm ?? EMPTY_FORM,
    ));
  const [manualEntry, setManualEntry] = useState(false);
  const [targetValue, setTargetValue] = useState(
    props.assignment?.target.available
      ? encodeTarget(props.assignment.target)
      : "",
  );
  const [toolUpdateMode, setToolUpdateMode] = useState<
    MessagingToolUpdateMode | ""
  >(props.assignment?.toolUpdateMode ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(props.assignment);
  const surfaceCandidates = observedSurfaceCandidates(
    props.observedSurfaces,
    form,
  );
  const hasConfiguredSurface =
    !manualEntry
    && surfaceSelection === "configured"
    && hasSurfaceIdentity(form);
  const scope = useMemo(
    () => props.assignment?.scope ?? buildScope(form),
    [form, props.assignment],
  );

  const save = async () => {
    if (!props.desktopApi?.setMessagingDefaultAgent) return;
    if (!props.assignment && !hasSurfaceIdentity(form)) {
      setError("Choose a recently seen surface or enter its ID manually.");
      return;
    }
    const target = decodeTarget(targetValue);
    if (!target) {
      setError("Choose an eligible Agent.");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await props.desktopApi.setMessagingDefaultAgent({
        ...(props.assignment
          ? { assignmentId: props.assignment.assignmentId }
          : {}),
        scope,
        target,
        ...(toolUpdateMode
          ? { toolUpdateMode }
          : props.assignment?.toolUpdateMode
            ? { toolUpdateMode: null }
            : {}),
      });
      await props.onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="messaging-route-editor">
      <div className="messaging-route-editor__heading">
        <strong>{editing ? "Change default Agent" : "Add default Agent"}</strong>
        {editing ? <span>{formatScopeLabel(scope)}</span> : null}
      </div>
      {!editing ? (
        <div className="messaging-route-editor__grid">
          <label>
            <span>Scope</span>
            <select
              aria-label="Default scope"
              className="settings-select"
              value={form.scopeKind}
              onChange={(event) => {
                const scopeKind = event.target.value as DefaultScopeKind;
                setForm((current) => resetSurfaceForm(current, { scopeKind }));
                setSurfaceSelection("");
                setManualEntry(false);
              }}
            >
              <option
                disabled={props.platforms.length === 0}
                value="conversation"
              >
                Conversation
              </option>
              <option disabled={props.platforms.length === 0} value="parent">
                Threads/topics in a channel or group
              </option>
              <option disabled={props.platforms.length === 0} value="workspace">
                Workspace or server
              </option>
              <option disabled={props.platforms.length === 0} value="provider">
                Messaging provider
              </option>
              <option value="profile">PwrAgent profile</option>
            </select>
          </label>
          {form.scopeKind !== "profile" ? (
            <label>
              <span>Platform</span>
              <select
                aria-label="Messaging platform"
                className="settings-select"
                value={form.platform}
                onChange={(event) => {
                  const platform = event.target.value as MessagingChannelKind;
                  setForm((current) => resetSurfaceForm(current, { platform }));
                  setSurfaceSelection("");
                  setManualEntry(false);
                }}
              >
                {props.platforms.map((platform) => (
                  <option key={platform} value={platform}>
                    {formatMessagingPlatformName(platform)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {form.scopeKind === "conversation"
            || form.scopeKind === "parent"
            || form.scopeKind === "workspace" ? (
            <label className="messaging-route-editor__surface">
              <span>Surface</span>
              <select
                aria-label="Messaging surface"
                className="settings-select"
                value={surfaceSelection}
                onChange={(event) => {
                  const value = event.target.value;
                  setSurfaceSelection(value);
                  if (value === "manual") {
                    setManualEntry(true);
                    setForm((current) => resetSurfaceForm(current));
                    return;
                  }
                  setManualEntry(false);
                  if (!value) {
                    setForm((current) => resetSurfaceForm(current));
                    return;
                  }
                  const candidate = surfaceCandidates.find(
                    (surface) => surface.value === value,
                  );
                  if (candidate) setForm(candidate.form);
                }}
              >
                <option value="">Choose a recently seen surface...</option>
                {hasConfiguredSurface ? (
                  <option value="configured">
                    {configuredSurfaceLabel(form)} - approved configuration
                  </option>
                ) : null}
                {surfaceCandidates.map((surface) => (
                  <option key={surface.value} value={surface.value}>
                    {surface.label} - seen {formatTimestamp(surface.lastSeenAt)}
                  </option>
                ))}
                <option value="manual">Enter an ID manually...</option>
              </select>
              {surfaceCandidates.length === 0 && !hasConfiguredSurface ? (
                <small>
                  {emptySurfaceMessage(form.scopeKind)}
                </small>
              ) : null}
            </label>
          ) : null}
          {manualEntry && form.scopeKind === "workspace" ? (
            <RouteTextInput
              label={workspaceIdLabel(form.platform)}
              value={form.workspaceId}
              onChange={(workspaceId) =>
                setForm((current) => ({ ...current, workspaceId }))}
            />
          ) : null}
          {manualEntry && form.scopeKind === "parent" ? (
            <RouteTextInput
              label={parentIdLabel(form.platform)}
              value={form.parentConversationId}
              onChange={(parentConversationId) =>
                setForm((current) => ({ ...current, parentConversationId }))}
            />
          ) : null}
          {manualEntry && form.scopeKind === "conversation" ? (
            <>
              <label>
                <span>Conversation type</span>
                <select
                  aria-label="Conversation type"
                  className="settings-select"
                  value={form.conversationKind}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      conversationKind: event.target.value as MessagingConversationKind,
                    }))}
                >
                  <option value="channel">Channel</option>
                  <option value="thread">Thread</option>
                  <option value="topic">Topic</option>
                  <option value="dm">Direct message</option>
                </select>
              </label>
              <RouteTextInput
                label="Conversation ID"
                value={form.conversationId}
                onChange={(conversationId) =>
                  setForm((current) => ({ ...current, conversationId }))}
              />
              <RouteTextInput
                label={identityParentIdLabel(form.platform, form.conversationKind)}
                optional
                value={form.identityParentId}
                onChange={(identityParentId) =>
                  setForm((current) => ({ ...current, identityParentId }))}
              />
              {(form.conversationKind === "thread"
                || form.conversationKind === "topic") ? (
                <RouteTextInput
                  label="Containing channel or group ID"
                  optional
                  value={form.parentConversationId}
                  onChange={(parentConversationId) =>
                    setForm((current) => ({ ...current, parentConversationId }))}
                />
              ) : null}
              <RouteTextInput
                label={workspaceIdLabel(form.platform)}
                optional
                value={form.workspaceId}
                onChange={(workspaceId) =>
                  setForm((current) => ({ ...current, workspaceId }))}
              />
              <RouteTextInput
                label="Display name"
                optional
                value={form.title}
                onChange={(title) =>
                  setForm((current) => ({ ...current, title }))}
              />
            </>
          ) : null}
        </div>
      ) : null}
      <label className="messaging-route-editor__field">
        <span>Agent</span>
        <select
          aria-label="Default Agent"
          className="settings-select"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
        >
          <option value="">Choose an Agent...</option>
          {props.agents.map((agent) => (
            <option key={encodeTarget(agent)} value={encodeTarget(agent)}>
              {agent.label} - {agent.backendLabel}
            </option>
          ))}
        </select>
      </label>
      <label className="messaging-route-editor__field">
        <span>Working Updates</span>
        <select
          aria-label="Route Working Updates"
          className="settings-select"
          value={toolUpdateMode}
          onChange={(event) =>
            setToolUpdateMode(
              event.target.value as MessagingToolUpdateMode | "",
            )}
        >
          <option value="">
            Use manager-agent default ({routeToolUpdateModeLabel(
              props.inheritedToolUpdateMode,
            )})
          </option>
          {ROUTE_TOOL_UPDATE_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="messaging-route-editor__error" role="alert">{error}</p> : null}
      <div className="messaging-route-editor__actions">
        <button
          className="button button--primary"
          disabled={saving}
          type="button"
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save default"}
        </button>
        <button
          className="button button--ghost"
          disabled={saving}
          type="button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function routeToolUpdateModeLabel(mode: MessagingToolUpdateMode): string {
  return ROUTE_TOOL_UPDATE_MODE_OPTIONS.find(
    (option) => option.value === mode,
  )?.label ?? "Show None";
}

function newDefaultForm(
  platforms: readonly MessagingChannelKind[],
): NewDefaultForm {
  const platform = platforms[0];
  return {
    ...EMPTY_FORM,
    scopeKind: platform ? "conversation" : "profile",
    platform: platform ?? EMPTY_FORM.platform,
  };
}

function platformsForForm(
  configured: readonly MessagingChannelKind[],
  form: NewDefaultForm,
): MessagingChannelKind[] {
  if (form.scopeKind === "profile" || configured.includes(form.platform)) {
    return [...configured];
  }
  return [form.platform, ...configured];
}

type ObservedSurfaceCandidate = {
  form: NewDefaultForm;
  label: string;
  lastSeenAt: number;
  value: string;
};

function observedSurfaceCandidates(
  surfaces: DesktopMessagingObservedSurface[],
  form: NewDefaultForm,
): ObservedSurfaceCandidate[] {
  if (form.scopeKind === "profile" || form.scopeKind === "provider") return [];
  const candidates = new Map<string, ObservedSurfaceCandidate>();
  for (const surface of surfaces) {
    if (surface.platform !== form.platform) continue;
    const conversation = surface.conversation;
    let candidateForm: NewDefaultForm | undefined;
    let label: string | undefined;
    if (form.scopeKind === "conversation") {
      candidateForm = {
        ...EMPTY_FORM,
        scopeKind: "conversation",
        platform: surface.platform,
        workspaceId: conversation.workspaceId ?? "",
        parentConversationId: conversation.parentConversationId ?? "",
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        identityParentId: conversation.parentId ?? "",
        title: conversation.title ?? "",
      };
      label = formatConversationLabel(surface.platform, conversation);
    } else if (form.scopeKind === "parent") {
      const parentConversationId = conversation.parentConversationId;
      if (!parentConversationId) continue;
      candidateForm = {
        ...EMPTY_FORM,
        scopeKind: "parent",
        platform: surface.platform,
        parentConversationId,
        title: conversation.parentTitle ?? "",
      };
      label = formatObservedContainerLabel({
        platform: surface.platform,
        id: parentConversationId,
        names: [
          conversation.ancestorTitle,
          conversation.parentTitle,
        ],
      });
    } else {
      const workspaceId = conversation.workspaceId;
      if (!workspaceId) continue;
      candidateForm = {
        ...EMPTY_FORM,
        scopeKind: "workspace",
        platform: surface.platform,
        workspaceId,
      };
      label = formatObservedContainerLabel({
        platform: surface.platform,
        id: workspaceId,
        names: [
          conversation.ancestorTitle,
          conversation.kind === "thread" || conversation.kind === "topic"
            ? undefined
            : conversation.parentTitle,
        ],
      });
    }
    const value = encodeSurfaceForm(candidateForm);
    if (candidates.has(value)) continue;
    candidates.set(value, {
      form: candidateForm,
      label,
      lastSeenAt: surface.lastSeenAt,
      value,
    });
  }
  return [...candidates.values()].sort((left, right) =>
    right.lastSeenAt - left.lastSeenAt
    || left.label.localeCompare(right.label));
}

function surfaceSelectionForForm(
  surfaces: DesktopMessagingObservedSurface[],
  form: NewDefaultForm,
): string {
  if (!hasSurfaceIdentity(form)) return "";
  const value = encodeSurfaceForm(form);
  return observedSurfaceCandidates(surfaces, form).some(
    (candidate) => candidate.value === value,
  )
    ? value
    : "configured";
}

function encodeSurfaceForm(form: NewDefaultForm): string {
  switch (form.scopeKind) {
    case "profile": return "profile";
    case "provider": return `provider:${form.platform}`;
    case "workspace": return JSON.stringify(["workspace", form.platform, form.workspaceId]);
    case "parent": return JSON.stringify(["parent", form.platform, form.parentConversationId]);
    case "conversation":
      return JSON.stringify([
        "conversation",
        form.platform,
        form.conversationKind,
        form.identityParentId,
        form.conversationId,
      ]);
  }
}

function resetSurfaceForm(
  form: NewDefaultForm,
  changes: Partial<Pick<NewDefaultForm, "platform" | "scopeKind">> = {},
): NewDefaultForm {
  return {
    ...EMPTY_FORM,
    platform: changes.platform ?? form.platform,
    scopeKind: changes.scopeKind ?? form.scopeKind,
  };
}

function hasSurfaceIdentity(form: NewDefaultForm): boolean {
  switch (form.scopeKind) {
    case "profile":
    case "provider":
      return true;
    case "workspace":
      return Boolean(form.workspaceId.trim());
    case "parent":
      return Boolean(form.parentConversationId.trim());
    case "conversation":
      return Boolean(form.conversationId.trim());
  }
}

function configuredSurfaceLabel(form: NewDefaultForm): string {
  if (form.title.trim()) {
    return `${formatMessagingPlatformName(form.platform)} / ${form.title.trim()}`;
  }
  return formatScopeLabel(buildScope(form));
}

function formatObservedContainerLabel(params: {
  platform: MessagingChannelKind;
  id: string;
  names: Array<string | undefined>;
}): string {
  const names = [...new Set(
    params.names.filter((value): value is string => Boolean(value?.trim())),
  )];
  return [
    formatMessagingPlatformName(params.platform),
    ...(names.length > 0 ? names : [params.id]),
  ].join(" / ");
}

function findApprovedSurfaceAssignment(
  assignments: DesktopMessagingDefaultAgentRoute[],
  surface: {
    id: string;
    platform: MessagingChannelKind;
    scopeKind: "conversation" | "parent" | "workspace";
  },
): DesktopMessagingDefaultAgentRoute | undefined {
  return assignments.find((assignment) => {
    const scope = assignment.scope;
    if (scope.kind !== surface.scopeKind || scope.platform !== surface.platform) {
      return false;
    }
    if (scope.kind === "workspace") return scope.workspaceId === surface.id;
    if (scope.kind === "parent") return scope.conversationId === surface.id;
    return scope.conversation.kind === "channel"
      && scope.conversation.id === surface.id;
  });
}

function approvedSurfaceInitialForm(surface: {
  id: string;
  platform: MessagingChannelKind;
  scopeKind: "conversation" | "parent" | "workspace";
  title?: string;
}): NewDefaultForm {
  return {
    ...EMPTY_FORM,
    scopeKind: surface.scopeKind,
    platform: surface.platform,
    workspaceId: surface.scopeKind === "workspace" ? surface.id : "",
    parentConversationId: surface.scopeKind === "parent" ? surface.id : "",
    conversationId: surface.scopeKind === "conversation" ? surface.id : "",
    title: surface.title?.trim() ?? "",
  };
}

function RouteTextInput(props: {
  label: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{props.label}{props.optional ? " (optional)" : ""}</span>
      <input
        className="settings-input"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function buildScope(form: NewDefaultForm): DesktopMessagingDefaultAgentScope {
  switch (form.scopeKind) {
    case "profile":
      return { kind: "profile" };
    case "provider":
      return { kind: "provider", platform: form.platform };
    case "workspace":
      return {
        kind: "workspace",
        platform: form.platform,
        workspaceId: form.workspaceId,
      };
    case "parent":
      return {
        kind: "parent",
        platform: form.platform,
        conversationId: form.parentConversationId,
      };
    case "conversation":
      return {
        kind: "conversation",
        platform: form.platform,
        conversation: {
          id: form.conversationId,
          kind: form.conversationKind,
          ...(form.identityParentId ? { parentId: form.identityParentId } : {}),
          ...(resolveParentConversationId(form)
            ? { parentConversationId: resolveParentConversationId(form) }
            : {}),
          ...(form.workspaceId ? { workspaceId: form.workspaceId } : {}),
          ...(form.title ? { title: form.title } : {}),
        },
      };
  }
}

function platformForScope(
  scope: DesktopMessagingDefaultAgentScope,
): MessagingChannelKind | undefined {
  return scope.kind === "profile" ? undefined : scope.platform;
}

function formatScopeLabel(scope: DesktopMessagingDefaultAgentScope): string {
  if (scope.kind === "profile") return "All messaging providers";
  const platform = formatMessagingPlatformName(scope.platform);
  if (scope.kind === "provider") return `All ${platform} conversations`;
  if (scope.kind === "workspace") return `${platform} / ${scope.workspaceId}`;
  if (scope.kind === "parent") return `${platform} / ${scope.conversationId}`;
  return formatConversationLabel(scope.platform, scope.conversation);
}

function formatConversationLabel(
  platform: MessagingChannelKind,
  conversation: {
    id: string;
    kind: MessagingConversationKind;
    title?: string;
    parentTitle?: string;
    ancestorTitle?: string;
  },
): string {
  const names = [
    conversation.ancestorTitle,
    conversation.parentTitle,
    conversation.title,
  ].filter((value): value is string => Boolean(value?.trim()));
  const identity = formatConversationIdentity(
    conversation.kind,
    conversation.id,
  );
  if (names.length === 0) {
    return `${formatMessagingPlatformName(platform)} / ${identity}`;
  }
  if (conversation.title?.trim()) {
    return `${formatMessagingPlatformName(platform)} / ${names.join(" / ")}`;
  }
  return `${formatMessagingPlatformName(platform)} / ${names.join(" / ")} / ${identity}`;
}

function formatConversationIdentity(
  kind: MessagingConversationKind,
  id: string,
): string {
  switch (kind) {
    case "dm": return `Direct message ${id}`;
    case "channel": return `Channel ${id}`;
    case "thread": return `Thread ${id}`;
    case "topic": return `Topic ${id}`;
  }
}

function formatScopeKind(kind: DefaultScopeKind): string {
  switch (kind) {
    case "profile": return "Profile default";
    case "provider": return "Provider default";
    case "workspace": return "Workspace default";
    case "parent": return "Child thread/topic default";
    case "conversation": return "Conversation default";
  }
}

function emptySurfaceMessage(kind: DefaultScopeKind): string {
  if (kind === "parent") {
    return (
      "No child threads or topics observed yet. Send the bot a message in one, "
      + "or enter the containing channel or group ID manually."
    );
  }
  return (
    "No matching surfaces observed yet. Send the bot a message there, "
    + "or enter the ID manually."
  );
}

function formatConversationKind(kind: MessagingConversationKind): string {
  switch (kind) {
    case "dm": return "Direct message";
    case "channel": return "Channel";
    case "thread": return "Thread";
    case "topic": return "Topic";
  }
}

function workspaceIdLabel(platform: MessagingChannelKind): string {
  if (platform === "discord") return "Server ID";
  if (platform === "mattermost") return "Team ID";
  if (platform === "feishu") return "Tenant ID";
  return "Workspace ID";
}

function parentIdLabel(platform: MessagingChannelKind): string {
  if (platform === "telegram") return "Containing group ID";
  return "Containing channel ID";
}

function identityParentIdLabel(
  platform: MessagingChannelKind,
  conversationKind: MessagingConversationKind,
): string {
  if (platform === "slack" && conversationKind === "thread") {
    return "Thread timestamp";
  }
  if (platform === "discord") return "Server ID";
  if (platform === "telegram" && conversationKind === "topic") return "Group ID";
  return "Identity parent ID";
}

function resolveParentConversationId(form: NewDefaultForm): string | undefined {
  if (form.parentConversationId) return form.parentConversationId;
  if (form.conversationKind !== "thread" && form.conversationKind !== "topic") {
    return undefined;
  }
  if (form.platform === "slack") return form.conversationId || undefined;
  if (form.platform === "telegram") return form.identityParentId || undefined;
  return undefined;
}

function encodeTarget(target: {
  backend: string;
  threadId: string;
}): string {
  return JSON.stringify([target.backend, target.threadId]);
}

function decodeTarget(value: string): {
  backend: DesktopMessagingAgentRouteTarget["backend"];
  threadId: string;
} | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === "string"
      && typeof parsed[1] === "string"
    ) {
      return { backend: parsed[0] as DesktopMessagingAgentRouteTarget["backend"], threadId: parsed[1] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Response behavior for one exact Discord channel or native thread.
 *
 * This sits beside Default Agents rather than inside it because the two
 * decisions are independent: admission runs first and only decides whether an
 * ambient message is accepted at all, and routing then picks the Agent for an
 * accepted unbound message. Sharing the observed-surface picker keeps operators
 * choosing a named channel instead of pasting a snowflake, but the two lists
 * never share a value.
 */
export type DiscordResponseBehaviorProps = {
  disabled?: boolean;
  loading?: boolean;
  observedSurfaces: DesktopMessagingObservedSurface[];
  source: string;
  value: DesktopAuthorizedContact[];
  onSave: (value: DesktopAuthorizedContact[]) => void;
};

function DiscordResponseBehavior(props: DiscordResponseBehaviorProps) {
  const selectId = useId();
  const configured = props.value;
  // Built once and shared with every row. Recomputing per row made the section
  // O(rows x surfaces log surfaces) on every render, and `observedSurfaces` is
  // a fresh array each render so a row-level memo could never have helped.
  const candidatesById = useMemo(
    () => discordResponseSurfaceCandidates(props.observedSurfaces),
    [props.observedSurfaces],
  );
  const unconfigured = useMemo(() => {
    const configuredIds = new Set(configured.map((entry) => entry.id));
    return [...candidatesById.values()]
      .filter((candidate) => !configuredIds.has(candidate.id));
  }, [candidatesById, configured]);

  const addSurface = (id: string) => {
    const candidate = candidatesById.get(id);
    if (!candidate || configured.some((entry) => entry.id === id)) return;
    props.onSave([
      ...configured,
      {
        id: candidate.id,
        displayName: candidate.displayName,
        responseMode: "mention_only",
      },
    ]);
  };

  // Indexed rather than keyed by id: `response_mode_overrides` is a plain array
  // that nothing dedupes, and the raw-ID editor this replaced could persist two
  // rows with the same snowflake. Matching by id would delete or rewrite both.
  const updateMode = (
    index: number,
    responseMode: DesktopMessagingResponseMode | undefined,
  ) => {
    props.onSave(configured.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry;
      const { responseMode: _drop, ...rest } = entry;
      return responseMode ? { ...rest, responseMode } : rest;
    }));
  };

  const removeSurface = (index: number) => {
    props.onSave(configured.filter((_entry, entryIndex) => entryIndex !== index));
  };

  return (
    <>
      <div className="messaging-routes__subhead">
        <strong>When PwrAgent responds</strong>
        <span>
          Pick a Discord channel or native thread PwrAgent has seen, then choose
          whether it replies to every message there or only when @ mentioned. A
          native thread's own setting beats its parent channel's. This does not
          choose an Agent or authorize access.
        </span>
        <span className="settings-source">{props.source}</span>
      </div>
      <div className="messaging-routes__response-add">
        <label className="settings-authorized-list__policy-label" htmlFor={selectId}>
          Add a channel or thread
        </label>
        <select
          className="settings-input"
          disabled={props.disabled || props.loading || unconfigured.length === 0}
          id={selectId}
          value=""
          onChange={(event) => {
            const id = event.currentTarget.value;
            if (id) addSurface(id);
          }}
        >
          <option value="">
            {props.loading
              ? "Loading channels..."
              : unconfigured.length === 0
                ? "No unconfigured Discord channels seen yet"
                : "Select a channel or thread..."}
          </option>
          {unconfigured.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </div>
      <div
        className="messaging-routes__list"
        aria-label="Discord channel and thread response behavior"
      >
        {props.loading ? (
          <p className="messaging-routes__empty">Loading routes...</p>
        ) : configured.length === 0 ? (
          <p className="messaging-routes__empty">
            Every Discord channel and native thread follows its server&apos;s
            setting, or the Discord-wide default when that server has none.
          </p>
        ) : (
          configured.map((entry, index) => (
            <DiscordResponseRow
              key={`${entry.id}-${index}`}
              disabled={props.disabled}
              entry={entry}
              observed={candidatesById.get(entry.id)}
              onChangeMode={(responseMode) => updateMode(index, responseMode)}
              onRemove={() => removeSurface(index)}
            />
          ))
        )}
      </div>
    </>
  );
}

function DiscordResponseRow(props: {
  disabled?: boolean;
  entry: DesktopAuthorizedContact;
  observed?: DiscordResponseSurfaceCandidate;
  onChangeMode: (responseMode: DesktopMessagingResponseMode | undefined) => void;
  onRemove: () => void;
}) {
  const selectId = useId();
  // A configured surface the adapter has not seen recently still has to render
  // with whatever identity we stored, so removing it stays possible. `||`, not
  // `??`: `displayName` is a required string that is routinely "".
  const label = props.observed?.label
    || props.entry.displayName.trim()
    || props.entry.id;
  const DiscordIcon = MESSAGING_PLATFORM_ICONS.discord;
  return (
    <div className="messaging-route-row">
      <div className="messaging-routes__response-identity">
        <div className="messaging-route-row__platform" aria-hidden="true">
          {DiscordIcon ? <DiscordIcon size={16} /> : null}
        </div>
        <div className="messaging-route-row__main">
          <div className="messaging-route-row__title">{label}</div>
          <div className="messaging-route-row__meta">
            {props.observed ? props.observed.kindLabel : "Not seen recently"}
            {" / ID "}
            {props.entry.id}
          </div>
        </div>
      </div>
      <div className="messaging-route-row__actions messaging-routes__response-controls">
        <label className="settings-authorized-list__policy-label" htmlFor={selectId}>
          Responds to
        </label>
        <select
          aria-label={`Responds to for ${label}`}
          className="settings-input"
          disabled={props.disabled}
          id={selectId}
          title={responseModeTitle("channel or thread")}
          value={props.entry.responseMode ?? ""}
          onChange={(event) => props.onChangeMode(
            event.currentTarget.value === ""
              ? undefined
              : event.currentTarget.value as DesktopMessagingResponseMode,
          )}
        >
          <option value="">Default (follow server)</option>
          {RESPONSE_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          aria-label={`Remove response behavior for ${label}`}
          className="button button--ghost"
          disabled={props.disabled}
          type="button"
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

type DiscordResponseSurfaceCandidate = {
  // True when this record was derived from a thread's parent pointer rather
  // than observed directly. A derived record carries a weaker identity and
  // must never displace a direct observation of the same channel.
  derived: boolean;
  displayName: string;
  id: string;
  kindLabel: string;
  label: string;
  lastSeenAt: number;
};

/**
 * Observed Discord channels and native threads, plus the parent channel of any
 * observed thread. The parent is offered because an operator who has only ever
 * seen thread traffic may still want to set the containing channel's behavior.
 */
function discordResponseSurfaceCandidates(
  surfaces: DesktopMessagingObservedSurface[],
): Map<string, DiscordResponseSurfaceCandidate> {
  const candidates = new Map<string, DiscordResponseSurfaceCandidate>();
  const remember = (candidate: DiscordResponseSurfaceCandidate) => {
    const existing = candidates.get(candidate.id);
    if (!existing) {
      candidates.set(candidate.id, candidate);
      return;
    }
    // A direct observation always wins over a derived one, however stale. The
    // adapter names a thread's parent from a separate REST fetch that can fail,
    // so a newer derived record is not a better record.
    if (existing.derived !== candidate.derived) {
      if (existing.derived) candidates.set(candidate.id, candidate);
      return;
    }
    if (existing.lastSeenAt >= candidate.lastSeenAt) return;
    candidates.set(candidate.id, candidate);
  };
  for (const surface of surfaces) {
    if (surface.platform !== "discord") continue;
    const conversation = surface.conversation;
    if (conversation.kind === "channel" || conversation.kind === "thread") {
      remember({
        derived: false,
        displayName: conversation.title ?? "",
        id: conversation.id,
        kindLabel: conversation.kind === "thread" ? "Native thread" : "Channel",
        label: formatConversationLabel("discord", conversation),
        lastSeenAt: surface.lastSeenAt,
      });
    }
    const parentConversationId = conversation.parentConversationId;
    if (conversation.kind === "thread" && parentConversationId) {
      // The adapter sets `ancestorTitle` only when it actually resolved the
      // parent channel's name; without it `parentTitle` holds the SERVER name
      // (`parentChannelName ?? guildName`), which would offer a channel under
      // its server's name. Fall back to the bare id instead of lying.
      const parentResolved = Boolean(conversation.ancestorTitle?.trim());
      const parentName = parentResolved ? conversation.parentTitle : undefined;
      remember({
        derived: true,
        displayName: parentName ?? "",
        id: parentConversationId,
        kindLabel: "Channel",
        label: formatObservedContainerLabel({
          platform: "discord",
          id: parentConversationId,
          names: parentResolved
            ? [conversation.ancestorTitle, conversation.parentTitle]
            : [],
        }),
        lastSeenAt: surface.lastSeenAt,
      });
    }
  }
  return disambiguateCandidateLabels(candidates);
}

/**
 * Discord does not enforce unique channel or thread names, so two surfaces can
 * format to the same label. The picker shows label text only, so a collision
 * would leave the operator unable to tell which snowflake they selected.
 */
function disambiguateCandidateLabels(
  candidates: Map<string, DiscordResponseSurfaceCandidate>,
): Map<string, DiscordResponseSurfaceCandidate> {
  const counts = new Map<string, number>();
  for (const candidate of candidates.values()) {
    counts.set(candidate.label, (counts.get(candidate.label) ?? 0) + 1);
  }
  const sorted = [...candidates.values()]
    .map((candidate) => (counts.get(candidate.label) ?? 0) > 1
      ? { ...candidate, label: `${candidate.label} (ID ${candidate.id})` }
      : candidate)
    .sort((left, right) =>
      right.lastSeenAt - left.lastSeenAt
      || left.label.localeCompare(right.label));
  return new Map(sorted.map((candidate) => [candidate.id, candidate]));
}
