import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ALL_MESSAGING_PERMISSIONS,
  RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE,
  roleIsDangerous,
  type MessagingPermissionDescriptor,
  type MessagingPermissionId,
  type ReadRbacPolicyResponse,
  type RbacAttachment,
  type RbacKnownSubject,
  type RbacRoleDefinition,
  type RbacSubject,
} from "@pwragent/shared";

import type { DesktopApi } from "../../lib/desktop-api";
import { DiscordIcon } from "../../icons/DiscordIcon";
import { FeishuIcon } from "../../icons/FeishuIcon";
import { LineIcon } from "../../icons/LineIcon";
import { MattermostIcon } from "../../icons/MattermostIcon";
import { SlackIcon } from "../../icons/SlackIcon";
import { TelegramIcon } from "../../icons/TelegramIcon";
import { SettingsPanelHead } from "./SettingsLayout";

type HoverTarget =
  | { kind: "subject"; key: string }
  | { kind: "role"; id: string }
  | { kind: "perm"; id: MessagingPermissionId }
  | null;

function subjectKey(subject: RbacSubject): string {
  if (subject.kind === "actor") {
    return `${subject.platform}:actor:${subject.actorId}`;
  }
  return `${subject.platform}:bucket:${subject.bucket}:${subject.scopeId ?? "*"}`;
}

function subjectLabel(subject: RbacSubject, displayName?: string): string {
  if (displayName) return displayName;
  if (subject.kind === "actor") return subject.actorId;
  return subject.bucket === "channel_any_user"
    ? "Any channel user"
    : "Any workspace DM user";
}

function subjectSub(subject: RbacSubject): string {
  if (subject.kind === "actor") return subject.actorId;
  return subject.bucket === "channel_any_user"
    ? subject.scopeId
      ? `channel ${subject.scopeId}`
      : "any channel"
    : "workspace DMs";
}

function platformLabel(platform: string): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

// --- inline glyphs (no icon lib in the renderer) ---
function Lock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function Alert() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17.5v.5" strokeLinecap="round" />
    </svg>
  );
}
function Eye() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}
function XMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function PlatformGlyph(props: { platform: string }): ReactNode {
  const size = 10;
  switch (props.platform) {
    case "slack":
      return <SlackIcon size={size} />;
    case "telegram":
      return <TelegramIcon size={size} />;
    case "discord":
      return <DiscordIcon size={size} />;
    case "mattermost":
      return <MattermostIcon size={size} />;
    case "line":
      return <LineIcon size={size} />;
    case "feishu":
      return <FeishuIcon size={size} />;
    default:
      return null;
  }
}

function Avatar(props: { subject: RbacSubject; displayName?: string; bucket?: boolean }) {
  const letter = props.bucket
    ? "?"
    : subjectLabel(props.subject, props.displayName)
        .replace(/^@/, "")
        .charAt(0)
        .toUpperCase() || "?";
  return (
    <span className={`rbac-avatar${props.bucket ? " is-bucket" : ""}`}>
      {letter}
      <span className="rbac-avatar__src" title={platformLabel(props.subject.platform)}>
        <PlatformGlyph platform={props.subject.platform} />
      </span>
    </span>
  );
}

export function AccessControlSettings(props: { desktopApi: DesktopApi }) {
  const { desktopApi } = props;
  const [policy, setPolicy] = useState<ReadRbacPolicyResponse | null>(null);
  const [knownSubjects, setKnownSubjects] = useState<RbacKnownSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverTarget>(null);
  // A pinned selection persists the highlight so you can scroll the long
  // permissions column while a role/actor stays traced. Hover only previews
  // when nothing is pinned.
  const [selected, setSelected] = useState<HoverTarget>(null);
  const [busy, setBusy] = useState(false);
  const [editingRole, setEditingRole] = useState<RbacRoleDefinition | "new" | null>(null);

  const reload = useCallback(async () => {
    if (!desktopApi.readRbacPolicy || !desktopApi.readRbacKnownSubjects) {
      setError("Access control is unavailable in this build.");
      setLoading(false);
      return;
    }
    try {
      const [nextPolicy, nextSubjects] = await Promise.all([
        desktopApi.readRbacPolicy(),
        desktopApi.readRbacKnownSubjects(),
      ]);
      setPolicy(nextPolicy);
      setKnownSubjects(nextSubjects.subjects);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Escape clears a pinned selection.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const subjects = useMemo<RbacKnownSubject[]>(() => {
    if (!policy) return knownSubjects;
    const byKey = new Map<string, RbacKnownSubject>();
    for (const known of knownSubjects) byKey.set(subjectKey(known.subject), known);
    for (const attachment of policy.attachments) {
      const key = subjectKey(attachment.subject);
      if (!byKey.has(key)) {
        byKey.set(key, {
          subject: attachment.subject,
          ...(attachment.displayName ? { displayName: attachment.displayName } : {}),
          bucket: attachment.subject.kind === "bucket",
        });
      }
    }
    return [...byKey.values()];
  }, [knownSubjects, policy]);

  const attachmentByKey = useMemo(() => {
    const map = new Map<string, RbacAttachment>();
    for (const attachment of policy?.attachments ?? []) {
      map.set(subjectKey(attachment.subject), attachment);
    }
    return map;
  }, [policy]);

  const roleById = useMemo(() => {
    const map = new Map<string, RbacRoleDefinition>();
    for (const role of policy?.roles ?? []) map.set(role.id, role);
    return map;
  }, [policy]);

  const rolesForSubjectKey = useCallback(
    (key: string): RbacRoleDefinition[] => {
      const attachment = attachmentByKey.get(key);
      if (!attachment) return [];
      return attachment.roleIds
        .map((id) => roleById.get(id))
        .filter((role): role is RbacRoleDefinition => Boolean(role));
    },
    [attachmentByKey, roleById],
  );

  const permsForSubjectKey = useCallback(
    (key: string): Set<MessagingPermissionId> => {
      const set = new Set<MessagingPermissionId>();
      for (const role of rolesForSubjectKey(key)) {
        for (const perm of role.permissions) set.add(perm);
      }
      return set;
    },
    [rolesForSubjectKey],
  );

  // permission id -> [{ subject, role }] reverse reach
  const reverseByPerm = useMemo(() => {
    const map = new Map<MessagingPermissionId, Array<{ subject: RbacKnownSubject; role: RbacRoleDefinition }>>();
    for (const perm of ALL_MESSAGING_PERMISSIONS) map.set(perm, []);
    for (const known of subjects) {
      const seen = new Set<string>();
      for (const role of rolesForSubjectKey(subjectKey(known.subject))) {
        for (const perm of role.permissions) {
          if (seen.has(perm)) continue;
          seen.add(perm);
          map.get(perm)?.push({ subject: known, role });
        }
      }
    }
    return map;
  }, [subjects, rolesForSubjectKey]);

  const rejectedSubjects = useMemo(
    () => subjects.filter((s) => rolesForSubjectKey(subjectKey(s.subject)).length === 0),
    [subjects, rolesForSubjectKey],
  );

  // ---- trace resolution (pinned selection wins over hover) ----
  const trace: HoverTarget = selected ?? hover;

  const isSubjectActive = useCallback(
    (key: string): boolean => {
      if (!trace) return false;
      if (trace.kind === "subject") return trace.key === key;
      if (trace.kind === "role") return rolesForSubjectKey(key).some((r) => r.id === trace.id);
      return permsForSubjectKey(key).has(trace.id);
    },
    [trace, rolesForSubjectKey, permsForSubjectKey],
  );
  const isRoleActive = useCallback(
    (roleId: string): boolean => {
      if (!trace) return false;
      if (trace.kind === "role") return trace.id === roleId;
      if (trace.kind === "subject") return rolesForSubjectKey(trace.key).some((r) => r.id === roleId);
      return roleById.get(roleId)?.permissions.includes(trace.id) ?? false;
    },
    [trace, rolesForSubjectKey, roleById],
  );
  const isPermActive = useCallback(
    (perm: MessagingPermissionId): boolean => {
      if (!trace) return false;
      if (trace.kind === "perm") return trace.id === perm;
      if (trace.kind === "role") return roleById.get(trace.id)?.permissions.includes(perm) ?? false;
      return permsForSubjectKey(trace.key).has(perm);
    },
    [trace, roleById, permsForSubjectKey],
  );
  const nodeClass = (active: boolean): string => (trace ? (active ? " is-active" : " is-dim") : "");

  const isPinned = (target: NonNullable<HoverTarget>): boolean => {
    if (!selected) return false;
    if (selected.kind !== target.kind) return false;
    return selected.kind === "subject"
      ? selected.key === (target as { key: string }).key
      : selected.id === (target as { id: string }).id;
  };
  const toggleSelect = (target: NonNullable<HoverTarget>) => {
    setSelected((current) => (isPinned(target) ? null : target));
  };

  // ---- SVG connector wires ----
  const containerRef = useRef<HTMLDivElement | null>(null);
  const actorRefs = useRef<Record<string, HTMLElement | null>>({});
  const roleRefs = useRef<Record<string, HTMLElement | null>>({});
  const permRefs = useRef<Record<string, HTMLElement | null>>({});
  const rejectRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    // ResizeObserver is absent under jsdom; the initial measure is enough there.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [subjects.length, policy?.roles.length]);

  const wires = useMemo(() => {
    const container = containerRef.current;
    if (!container) return { actorRole: [], rolePerm: [], reject: [] as Array<{ id: string; d: string; key: string }> };
    const cb = container.getBoundingClientRect();
    const right = (el: HTMLElement | null) =>
      el ? { x: el.getBoundingClientRect().right - cb.left, y: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - cb.top } : null;
    const left = (el: HTMLElement | null) =>
      el ? { x: el.getBoundingClientRect().left - cb.left, y: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - cb.top } : null;
    const path = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) => {
      if (!a || !b) return "";
      const dx = Math.max(40, (b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };
    const actorRole: Array<{ id: string; d: string; key: string; roleId: string; danger: boolean }> = [];
    const rolePerm: Array<{ id: string; d: string; roleId: string; permId: string; danger: boolean }> = [];
    const reject: Array<{ id: string; d: string; key: string }> = [];
    for (const known of subjects) {
      const key = subjectKey(known.subject);
      const aEl = actorRefs.current[key];
      const roles = rolesForSubjectKey(key);
      if (roles.length === 0) {
        const rj = rejectRef.current;
        if (aEl && rj) reject.push({ id: `rj-${key}`, d: path(right(aEl), left(rj)), key });
        continue;
      }
      for (const role of roles) {
        const rEl = roleRefs.current[role.id];
        if (aEl && rEl) {
          actorRole.push({
            id: `${key}-${role.id}`,
            d: path(right(aEl), left(rEl)),
            key,
            roleId: role.id,
            danger: Boolean(role.danger),
          });
        }
      }
    }
    for (const role of policy?.roles ?? []) {
      const rEl = roleRefs.current[role.id];
      for (const permId of role.permissions) {
        const pEl = permRefs.current[permId];
        const perm = policy?.permissionCatalog.find((p) => p.id === permId);
        if (rEl && pEl) {
          rolePerm.push({
            id: `${role.id}-${permId}`,
            d: path(right(rEl), left(pEl)),
            roleId: role.id,
            permId,
            danger: Boolean(role.danger) || perm?.danger === "high",
          });
        }
      }
    }
    return { actorRole, rolePerm, reject };
  }, [size.w, size.h, subjects, policy, rolesForSubjectKey]);

  const wireActive = (which: "ar" | "rp" | "rj", info: { key?: string; roleId?: string; permId?: string }): boolean => {
    if (!trace) return false;
    if (trace.kind === "subject") {
      if (which === "ar" || which === "rj") return info.key === trace.key;
      if (which === "rp") return rolesForSubjectKey(trace.key).some((r) => r.id === info.roleId);
    }
    if (trace.kind === "role") {
      if (which === "ar" || which === "rp") return info.roleId === trace.id;
    }
    if (trace.kind === "perm") {
      if (which === "rp") return info.permId === trace.id;
      if (which === "ar") return roleById.get(info.roleId ?? "")?.permissions.includes(trace.id) ?? false;
    }
    return false;
  };
  const wireClass = (which: "ar" | "rp" | "rj", info: { key?: string; roleId?: string; permId?: string }, danger?: boolean) => {
    const base = which === "rj" ? "is-reject" : "is-allow";
    const dangerCls = danger ? " is-danger" : "";
    if (!trace) return `${base}${dangerCls}`;
    return `${base}${dangerCls}${wireActive(which, info) ? " is-active" : " is-dim"}`;
  };

  // ---- mutations ----
  const runMutation = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      try {
        const result = await fn();
        if (!result.ok) setError(result.error ?? "That change could not be saved.");
        else {
          setError(null);
          await reload();
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const toggleRoleOnSubject = useCallback(
    (subject: RbacSubject, roleId: string) => {
      if (!desktopApi.writeRbacAttachment) return;
      const key = subjectKey(subject);
      const current = attachmentByKey.get(key)?.roleIds ?? [];
      const nextIds = current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId];
      const known = subjects.find((s) => subjectKey(s.subject) === key);
      void runMutation(() =>
        desktopApi.writeRbacAttachment!({
          attachment: {
            subject,
            roleIds: nextIds,
            ...(known?.displayName ? { displayName: known.displayName } : {}),
          },
        }),
      );
    },
    [attachmentByKey, desktopApi, runMutation, subjects],
  );

  const setEnforced = useCallback(
    (enforced: boolean) => {
      if (!desktopApi.setRbacEnforced) return;
      void runMutation(() => desktopApi.setRbacEnforced!({ enforced }));
    },
    [desktopApi, runMutation],
  );

  if (loading) {
    return <SettingsPanelHead eyebrow="Access Control" title="Authorization graph" help="Loading policy…" />;
  }

  const enforced = policy?.enforced ?? false;
  const roles = policy?.roles ?? [];
  const catalog = policy?.permissionCatalog ?? [];

  return (
    <>
      <SettingsPanelHead
        eyebrow="Access Control"
        title="Authorization graph"
        help={
          <>
            Bind messaging-platform actors to one or more role profiles.
            Permissions are <b>strictly additive</b> — if any bound role grants a
            capability, the actor has it. Hover any node to trace the path, or{" "}
            <b>click to pin</b> it so the highlight stays while you scroll the
            permissions column.
          </>
        }
        action={
          <button
            type="button"
            className={`button ${enforced ? "button--ghost" : "button--primary"}`}
            disabled={busy || !desktopApi.setRbacEnforced}
            onClick={() => setEnforced(!enforced)}
          >
            {enforced ? "Disable enforcement" : "Enable access control"}
          </button>
        }
      />

      {error ? (
        <div className="rbac-callout is-danger" role="alert">
          <span className="rbac-callout__icon">
            <Alert />
          </span>
          <div>
            <div className="rbac-callout__title">Something went wrong</div>
            <div className="rbac-callout__body">{error}</div>
          </div>
        </div>
      ) : null}

      {!enforced ? (
        <div className="rbac-banner">
          <div className="rbac-banner__title">Access control is not enforced</div>
          <div className="rbac-banner__body">
            Until you enable it, every authorized user has full (Admin)
            capability, exactly as before. Enabling seeds a starting policy: every
            currently authorized actor becomes <b>Admin</b>, and the wide bucket
            subjects (any-channel / any-workspace users) are surfaced as Admin so
            you can review and down-scope them.
          </div>
        </div>
      ) : null}

      <div className="rbac-callout is-danger">
        <span className="rbac-callout__icon">
          <Alert />
        </span>
        <div>
          <div className="rbac-callout__title">Codex Full Access is escalation-equivalent</div>
          <div className="rbac-callout__body">
            Granting <code>thread.execution.full_access</code> gives the actor
            near-complete control of the host machine. Treat it like{" "}
            <code>sudo</code>. Adding it to a custom role requires a typed
            confirmation.
          </div>
        </div>
      </div>

      <div className="rbac-toolbar">
        <div className="rbac-legend">
          <span className="rbac-legend__sw">
            <span className="rbac-legend__line is-allow" /> Allow
          </span>
          <span className="rbac-legend__sw">
            <span className="rbac-legend__line is-danger" /> Dangerous path
          </span>
          <span className="rbac-legend__sw">
            <span className="rbac-legend__line is-reject" /> Reject (no role)
          </span>
        </div>
        <span className="rbac-toolbar__sp" />
        {selected ? (
          <button type="button" className="button button--ghost" onClick={() => setSelected(null)}>
            Clear selection (Esc)
          </button>
        ) : null}
        <button type="button" className="button button--ghost" onClick={() => setEditingRole("new")}>
          + New custom role
        </button>
      </div>

      <div className="rbac-graph" ref={containerRef}>
        <svg className="rbac-graph__svg" width={size.w} height={size.h}>
          {wires.reject.map((w) => (
            <path key={w.id} d={w.d} className={wireClass("rj", w)} />
          ))}
          {wires.actorRole.map((w) => (
            <path key={w.id} d={w.d} className={wireClass("ar", w, w.danger)} />
          ))}
          {wires.rolePerm.map((w) => (
            <path key={w.id} d={w.d} className={wireClass("rp", w, w.danger)} />
          ))}
        </svg>

        <div className="rbac-graph__cols">
          {/* ACTORS */}
          <div>
            <div className="rbac-col__head">
              <span className="rbac-col__eyebrow">Actors</span>
              <span className="rbac-col__count">{subjects.length}</span>
            </div>
            <div className="rbac-col__list" aria-label="Actors">
              {subjects.map((known) => {
                const key = subjectKey(known.subject);
                const attached = rolesForSubjectKey(key);
                return (
                  <div
                    key={key}
                    ref={(el) => {
                      actorRefs.current[key] = el;
                    }}
                    className={`rbac-node${nodeClass(isSubjectActive(key))}${known.bucket ? " is-danger" : ""}${isPinned({ kind: "subject", key }) ? " is-pinned" : ""}`}
                    onMouseEnter={() => setHover({ kind: "subject", key })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => toggleSelect({ kind: "subject", key })}
                  >
                    <Avatar subject={known.subject} displayName={known.displayName} bucket={known.bucket} />
                    <div className="rbac-node__main">
                      <div className="rbac-node__name">
                        {subjectLabel(known.subject, known.displayName)}
                        {known.bucket ? <span className="rbac-node__badge is-danger">bucket</span> : null}
                      </div>
                      <div className="rbac-node__sub">
                        {platformLabel(known.subject.platform)} · {subjectSub(known.subject)}
                      </div>
                      <div className="rbac-node__roles">
                        {roles.map((role) => {
                          const on = attached.some((r) => r.id === role.id);
                          return (
                            <button
                              key={role.id}
                              type="button"
                              className={`rbac-chip${on ? " is-on" : ""}${role.danger ? " is-danger" : ""}`}
                              disabled={busy || !desktopApi.writeRbacAttachment}
                              title={`${on ? "Remove" : "Add"} ${role.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleRoleOnSubject(known.subject, role.id);
                              }}
                            >
                              {role.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {attached.length === 0 ? (
                      <span className="rbac-node__badge is-reject">No role</span>
                    ) : null}
                  </div>
                );
              })}
              {subjects.length === 0 ? (
                <div className="rbac-empty">
                  No messaging actors are configured yet. Authorize users under
                  Settings → Messaging first.
                </div>
              ) : null}
            </div>
          </div>

          {/* ROLES */}
          <div>
            <div className="rbac-col__head">
              <span className="rbac-col__eyebrow">PwrAgent · Roles (additive)</span>
              <span className="rbac-col__count">{roles.length}</span>
            </div>
            <div className="rbac-col__list" aria-label="Roles">
              {roles.map((role) => (
                <div
                  key={role.id}
                  ref={(el) => {
                    roleRefs.current[role.id] = el;
                  }}
                  className={`rbac-node${role.danger ? " is-danger" : ""}${nodeClass(isRoleActive(role.id))}${isPinned({ kind: "role", id: role.id }) ? " is-pinned" : ""}`}
                  onMouseEnter={() => setHover({ kind: "role", id: role.id })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => toggleSelect({ kind: "role", id: role.id })}
                >
                  <span
                    className={`rbac-avatar${role.danger ? " is-bucket" : ""}`}
                    style={role.danger ? undefined : { color: "var(--accent-bright)" }}
                  >
                    {role.danger ? <Alert /> : <Lock />}
                  </span>
                  <div className="rbac-node__main">
                    <div className="rbac-node__name">{role.name}</div>
                    <div className="rbac-node__sub" style={{ fontFamily: "var(--font-sans)" }}>
                      {role.description ?? `${role.permissions.length} permissions`}
                    </div>
                  </div>
                  <span className={`rbac-node__badge${role.danger ? " is-danger" : role.builtIn ? " is-builtin" : ""}`}>
                    {role.danger ? "Danger" : role.builtIn ? "Built-in" : "Custom"}
                  </span>
                  {!role.builtIn ? (
                    <button
                      type="button"
                      className="rbac-node__edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingRole(role);
                      }}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="rbac-node rbac-node--add" onClick={() => setEditingRole("new")}>
                + New custom role
              </button>
            </div>
          </div>

          {/* PERMISSIONS */}
          <div>
            <div className="rbac-col__head">
              <span className="rbac-col__eyebrow">Permissions</span>
              <span className="rbac-col__count">{catalog.length}</span>
            </div>
            <div className="rbac-col__list" aria-label="Permissions">
              {catalog.map((perm) => {
                const reach = reverseByPerm.get(perm.id)?.length ?? 0;
                const wide = perm.danger === "high" && reach > 1;
                return (
                  <div
                    key={perm.id}
                    ref={(el) => {
                      permRefs.current[perm.id] = el;
                    }}
                    className={`rbac-node${perm.danger === "high" ? " is-danger" : ""}${nodeClass(isPermActive(perm.id))}${isPinned({ kind: "perm", id: perm.id }) ? " is-pinned" : ""}`}
                    onMouseEnter={() => setHover({ kind: "perm", id: perm.id })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => toggleSelect({ kind: "perm", id: perm.id })}
                  >
                    <span
                      className={`rbac-avatar${perm.danger === "high" ? " is-bucket" : ""}`}
                      style={perm.danger ? undefined : { color: "var(--accent-bright)" }}
                    >
                      {perm.danger === "high" ? <Alert /> : perm.danger === "med" ? <Eye /> : <Check />}
                    </span>
                    <div className="rbac-node__main">
                      <div className="rbac-node__name">{perm.label}</div>
                      <div className="rbac-node__sub" style={{ fontFamily: "var(--font-sans)" }}>
                        {perm.description}
                      </div>
                    </div>
                    <span
                      className={`rbac-revcount${wide ? " is-wide" : ""}${reach === 0 ? " is-zero" : ""}`}
                      title={`${reach} actor(s) currently reach this`}
                    >
                      ↩ {reach}
                    </span>
                  </div>
                );
              })}
            </div>

            <div
              ref={rejectRef}
              className="rbac-reject"
              onMouseEnter={() => setHover(null)}
            >
              <span className="rbac-reject__icon">
                <XMark />
              </span>
              <div style={{ flex: 1 }}>
                <div className="rbac-reject__title">End state · Rejected</div>
                <div className="rbac-reject__sub">
                  Actors with zero matching roles fall through to a hard reject.
                </div>
              </div>
              <span className="rbac-reject__count">{rejectedSubjects.length}</span>
            </div>
          </div>
        </div>

        {/* Permission reverse-map tooltip */}
        {trace?.kind === "perm" ? (
          <PermTooltip
            perm={catalog.find((p) => p.id === trace.id)}
            rows={reverseByPerm.get(trace.id) ?? []}
          />
        ) : null}
      </div>

      {editingRole ? (
        <RoleEditor
          desktopApi={desktopApi}
          catalog={catalog}
          role={editingRole === "new" ? null : editingRole}
          onClose={() => setEditingRole(null)}
          onSaved={async () => {
            setEditingRole(null);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function PermTooltip(props: {
  perm?: MessagingPermissionDescriptor;
  rows: Array<{ subject: RbacKnownSubject; role: RbacRoleDefinition }>;
}) {
  if (!props.perm) return null;
  const roleCount = new Set(props.rows.map((r) => r.role.id)).size;
  return (
    <div className="rbac-tip" style={{ right: 18, top: 64 }}>
      <div className="rbac-tip__title">{props.perm.label}</div>
      <div className="rbac-tip__lede">
        Reachable by <b style={{ color: "var(--text-primary)" }}>{props.rows.length}</b> actor
        {props.rows.length === 1 ? "" : "s"} via{" "}
        <b style={{ color: "var(--text-primary)" }}>{roleCount}</b> role
        {roleCount === 1 ? "" : "s"}.
      </div>
      <div className="rbac-tip__list">
        {props.rows.slice(0, 6).map((row, i) => (
          <div key={i} className="rbac-tip__row">
            <Avatar
              subject={row.subject.subject}
              displayName={row.subject.displayName}
              bucket={row.subject.bucket}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {subjectLabel(row.subject.subject, row.subject.displayName)}
            </span>
            <span className="rbac-tip__via">via {row.role.name}</span>
          </div>
        ))}
        {props.rows.length > 6 ? (
          <div className="rbac-tip__more">+ {props.rows.length - 6} more</div>
        ) : null}
        {props.rows.length === 0 ? (
          <div className="rbac-tip__row" style={{ color: "var(--text-subtle)" }}>
            No actor currently reaches this.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RoleEditor(props: {
  desktopApi: DesktopApi;
  catalog: readonly MessagingPermissionDescriptor[];
  role: RbacRoleDefinition | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { desktopApi, catalog, role } = props;
  const [name, setName] = useState(role?.name ?? "");
  const [permissions, setPermissions] = useState<Set<MessagingPermissionId>>(
    () => new Set(role?.permissions ?? []),
  );
  const [phrase, setPhrase] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dangerous = roleIsDangerous([...permissions]);
  const phraseOk = !dangerous || phrase.trim() === RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE;

  const togglePerm = (perm: MessagingPermissionId) => {
    setPermissions((current) => {
      const next = new Set(current);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  const save = async () => {
    if (!desktopApi.writeRbacRole) return;
    if (!name.trim()) {
      setSaveError("Give the role a name.");
      return;
    }
    setSaving(true);
    try {
      const id = role?.id ?? `role_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const result = await desktopApi.writeRbacRole({
        role: { id, name: name.trim(), builtIn: false, permissions: [...permissions] },
        ...(dangerous ? { fullAccessAcknowledgment: phrase.trim() } : {}),
      });
      if (!result.ok) {
        setSaveError(result.error ?? "Could not save role.");
        return;
      }
      await props.onSaved();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!desktopApi.deleteRbacRole || !role) return;
    setSaving(true);
    try {
      const result = await desktopApi.deleteRbacRole({ roleId: role.id });
      if (!result.ok) {
        setSaveError(result.error ?? "Could not delete role.");
        return;
      }
      await props.onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rbac-editor" role="dialog" aria-label="Edit role">
      <div className="rbac-editor__head">
        <input
          className="rbac-editor__name"
          placeholder="Role name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" className="button button--ghost" onClick={props.onClose}>
          Cancel
        </button>
      </div>
      <div className="rbac-editor__perms">
        {catalog.map((perm) => (
          <label key={perm.id} className={`rbac-perm-check${perm.danger === "high" ? " is-danger" : ""}`}>
            <input type="checkbox" checked={permissions.has(perm.id)} onChange={() => togglePerm(perm.id)} />
            <span className="rbac-perm-check__label">{perm.label}</span>
          </label>
        ))}
      </div>
      {dangerous ? (
        <div className="rbac-editor__ack">
          <p>
            This role grants Codex Full Access. Type the phrase to confirm:
            <br />
            <code>{RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE}</code>
          </p>
          <input
            className="rbac-editor__name"
            placeholder="Type the confirmation phrase"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
          />
        </div>
      ) : null}
      {saveError ? (
        <div className="rbac-callout is-danger" role="alert">
          <div className="rbac-callout__body">{saveError}</div>
        </div>
      ) : null}
      <div className="rbac-editor__actions">
        {role ? (
          <button type="button" className="button button--ghost" disabled={saving} onClick={() => void remove()}>
            Delete role
          </button>
        ) : null}
        <button
          type="button"
          className="button button--primary"
          disabled={saving || !phraseOk}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save role"}
        </button>
      </div>
    </div>
  );
}
