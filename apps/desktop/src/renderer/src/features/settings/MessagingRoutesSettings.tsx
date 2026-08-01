import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  DesktopMessagingAgentRouteTarget,
  DesktopMessagingDefaultAgentRoute,
  DesktopMessagingDefaultAgentScope,
  ListMessagingRoutesResponse,
  MessagingChannelKind,
  MessagingConversationKind,
} from "@pwragent/shared";
import { PlusIcon } from "../../icons";
import {
  MESSAGING_PLATFORM_ICONS,
  formatMessagingPlatformName,
} from "../../lib/messaging-platform-branding";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSection } from "./SettingsLayout";

const EMPTY_ROUTES: ListMessagingRoutesResponse = {
  defaultAgents: [],
  bindings: [],
  eligibleAgents: [],
};

const ROUTE_PLATFORMS: MessagingChannelKind[] = [
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "feishu",
  "line",
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

export function MessagingRoutesSettings(props: { desktopApi?: DesktopApi }) {
  const [routes, setRoutes] = useState<ListMessagingRoutesResponse>(EMPTY_ROUTES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<DesktopMessagingDefaultAgentRoute | null>(
    null,
  );

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

  const clearDefault = async (assignmentId: string) => {
    if (!props.desktopApi?.clearMessagingDefaultAgent) return;
    setBusyId(assignmentId);
    try {
      await props.desktopApi.clearMessagingDefaultAgent({ assignmentId });
      if (editing?.assignmentId === assignmentId) setEditing(null);
      await loadRoutes();
    } catch (mutationError) {
      setError(
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
      setError(
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
      <div className="messaging-routes">
        <div className="messaging-routes__toolbar">
          <div>
            <strong>Default Agents</strong>
            <span>Choose which Agent receives addressed messages on unbound surfaces.</span>
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
              setShowAdd((current) => !current);
            }}
          >
            <PlusIcon size={14} />
            Add default
          </button>
        </div>

        {error ? (
          <p className="messaging-routes__error" role="alert">{error}</p>
        ) : null}

        {showAdd ? (
          <DefaultAgentEditor
            agents={routes.eligibleAgents}
            onCancel={() => setShowAdd(false)}
            onSaved={async () => {
              setShowAdd(false);
              await loadRoutes();
            }}
            desktopApi={props.desktopApi}
          />
        ) : null}

        {editing ? (
          <DefaultAgentEditor
            agents={routes.eligibleAgents}
            assignment={editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await loadRoutes();
            }}
            desktopApi={props.desktopApi}
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
              />
            ))
          )}
        </div>

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
              return (
                <div className="messaging-route-row" key={binding.bindingId}>
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
                    <span>{binding.target.label}</span>
                    <code>{binding.target.threadId}</code>
                  </div>
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
}) {
  const platform = platformForScope(props.route.scope);
  const Icon = platform ? MESSAGING_PLATFORM_ICONS[platform] : undefined;
  return (
    <div className="messaging-route-row">
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
        <span>{props.route.target.label}</span>
        <small className={props.route.target.available ? "is-ok" : "is-stale"}>
          {props.route.target.available
            ? props.route.target.backendLabel
            : `${props.route.target.backendLabel} unavailable`}
        </small>
      </div>
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

function DefaultAgentEditor(props: {
  agents: DesktopMessagingAgentRouteTarget[];
  assignment?: DesktopMessagingDefaultAgentRoute;
  desktopApi?: DesktopApi;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<NewDefaultForm>(EMPTY_FORM);
  const [targetValue, setTargetValue] = useState(
    props.assignment?.target.available
      ? encodeTarget(props.assignment.target)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(props.assignment);
  const scope = useMemo(
    () => props.assignment?.scope ?? buildScope(form),
    [form, props.assignment],
  );

  const save = async () => {
    if (!props.desktopApi?.setMessagingDefaultAgent) return;
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
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  scopeKind: event.target.value as DefaultScopeKind,
                }))}
            >
              <option value="conversation">Conversation</option>
              <option value="parent">Parent channel or group</option>
              <option value="workspace">Workspace or server</option>
              <option value="provider">Messaging provider</option>
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
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    platform: event.target.value as MessagingChannelKind,
                  }))}
              >
                {ROUTE_PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>
                    {formatMessagingPlatformName(platform)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {form.scopeKind === "workspace" ? (
            <RouteTextInput
              label={workspaceIdLabel(form.platform)}
              value={form.workspaceId}
              onChange={(workspaceId) =>
                setForm((current) => ({ ...current, workspaceId }))}
            />
          ) : null}
          {form.scopeKind === "parent" ? (
            <RouteTextInput
              label={parentIdLabel(form.platform)}
              value={form.parentConversationId}
              onChange={(parentConversationId) =>
                setForm((current) => ({ ...current, parentConversationId }))}
            />
          ) : null}
          {form.scopeKind === "conversation" ? (
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
      <label className="messaging-route-editor__agent">
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
  return names.length > 0
    ? `${formatMessagingPlatformName(platform)} / ${names.join(" / ")}`
    : `${formatMessagingPlatformName(platform)} / ${conversation.id}`;
}

function formatScopeKind(kind: DefaultScopeKind): string {
  switch (kind) {
    case "profile": return "Profile default";
    case "provider": return "Provider default";
    case "workspace": return "Workspace default";
    case "parent": return "Parent default";
    case "conversation": return "Conversation default";
  }
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
  if (platform === "telegram") return "Group ID";
  return "Parent channel ID";
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
