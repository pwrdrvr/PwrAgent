/* eslint-disable */
/* RBAC — Access Control panel
   Three-column authorization graph: Actors → Roles → Permissions.
   Strictly additive policy semantics (union of all bound roles).
*/
const { useState: useRBACState, useMemo: useRBACMemo, useRef: useRBACRef, useLayoutEffect, useEffect: useRBACEffect } = React;

/* ---------- Data ---------- */
const RBAC_ACTORS = [
  // Telegram named
  { id: "a1", name: "@huntharo",      kind: "user", source: "Telegram", note: "id 8460800771 · admin", roles: ["r1","r2","r3","r4"] },
  { id: "a2", name: "@thomas_m",      kind: "user", source: "Telegram", note: "id 4477120091",          roles: ["r1","r2","r3"] },
  { id: "a3", name: "@jamie_d",       kind: "user", source: "Telegram", note: "id 9912884001",          roles: ["r1","r2"] },
  // Discord named
  { id: "a4", name: "hunt.dev",       kind: "user", source: "Discord",  note: "guild #pwragent-internal", roles: ["r2","r5"] },
  { id: "a5", name: "ops-bot",        kind: "user", source: "Discord",  note: "guild #pwragent-internal · webhook", roles: ["r1"] },
  // Buckets
  { id: "b1", name: "Unspecified senders",
    kind: "bucket", source: "Discord",
    note: "guild #pwragent-staging · 47 members",
    bucketCount: 47, roles: [] },
  { id: "b2", name: "Unspecified senders",
    kind: "bucket", source: "Telegram",
    note: "DMs from non-allowlisted IDs · 12 today",
    bucketCount: 12, roles: [] },
];

const RBAC_ROLES = [
  { id: "r1", name: "Read-Only Observer",     builtin: true, sub: "Watch threads, no actions.",                   perms: ["p2"] },
  { id: "r2", name: "Thread Starter",         builtin: true, sub: "Start threads + read-only sandbox runs.",      perms: ["p1","p2","p5"] },
  { id: "r3", name: "Codex Default Operator", builtin: true, sub: "Sandboxed Codex with default access mode.",    perms: ["p1","p2","p3","p4","p5"] },
  { id: "r4", name: "Codex Full Operator",    builtin: true, danger: true,
    sub: "Unrestricted host shell. Can grant itself new permissions.",
    perms: ["p1","p2","p3","p4","p5","p6","p7","p8"] },
  { id: "r5", name: "drvr-billing Steward",   builtin: false, sub: "Custom — scoped to drvr-billing repo only.", perms: ["p1","p2","p4","p6"] },
];

const RBAC_PERMS = [
  { id: "p1", name: "Start agent thread",          sub: "Open a new thread, any model." },
  { id: "p2", name: "View thread activity",        sub: "Read transcripts and tool calls." },
  { id: "p3", name: "Start Codex dev thread",      sub: "Codex with editor + worktree." },
  { id: "p4", name: "Codex Default Access",        sub: "Sandboxed file ops, prompted writes." },
  { id: "p5", name: "Codex Read-Only Sandbox",     sub: "No writes, no shell side-effects." },
  { id: "p6", name: "Add directories to Codex",    sub: "Grow the trust root.", danger: "med" },
  { id: "p7", name: "Codex Full Access",           sub: "Unrestricted host shell.", danger: "high" },
  { id: "p8", name: "Modify configs · grant roles", sub: "Self-elevation surface.", danger: "high" },
];

/* Reverse map: each permission → list of {actor, viaRole} */
function rbacBuildReverse() {
  const map = {};
  RBAC_PERMS.forEach(p => map[p.id] = []);
  RBAC_ACTORS.forEach(a => {
    const seen = new Set();
    (a.roles || []).forEach(rid => {
      const role = RBAC_ROLES.find(r => r.id === rid);
      if (!role) return;
      role.perms.forEach(pid => {
        // Track first role granting this permission to keep tooltip clean.
        const key = `${a.id}|${pid}`;
        if (seen.has(key)) return;
        seen.add(key);
        map[pid].push({ actor: a, role });
      });
    });
  });
  return map;
}

/* ---------- Components ---------- */

function Avatar({ actor }) {
  const I = window.PA.Icon;
  const letter = actor.kind === "bucket"
    ? "?"
    : actor.name.replace(/^@/, "")[0].toUpperCase();
  const SrcGlyph = actor.source === "Telegram" ? I.Telegram : actor.source === "Discord" ? I.Discord : I.Slack;
  return (
    <span className={`rbac-avatar ${actor.kind === "bucket" ? "is-bucket" : ""}`}>
      {letter}
      <span className="rbac-avatar__src" title={actor.source}>
        <SrcGlyph size={9} brand />
      </span>
    </span>
  );
}

function PermDangerGlyph({ danger }) {
  const I = window.PA.Icon;
  if (danger === "high") return <I.AlertTriangle size={13} />;
  if (danger === "med")  return <I.Eye size={13} />;
  return null;
}

function RBACGraph() {
  const I = window.PA.Icon;
  const containerRef = useRBACRef(null);
  const colsRef = useRBACRef(null);
  const actorRefs = useRBACRef({});
  const roleRefs = useRBACRef({});
  const permRefs = useRBACRef({});
  const rejectRef = useRBACRef(null);
  const [size, setSize] = useRBACState({ w: 0, h: 0 });
  const [hover, setHover] = useRBACState(null); // {kind, id}
  const [tipPos, setTipPos] = useRBACState(null);

  const reverse = useRBACMemo(rbacBuildReverse, []);

  // Recompute sizes on layout
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      const r = containerRef.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  /* compute path between two element rects (right edge -> left edge) */
  const compute = () => {
    if (!containerRef.current) return { actorRole: [], rolePerm: [], reject: [] };
    const cb = containerRef.current.getBoundingClientRect();
    const right = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.right - cb.left, y: r.top + r.height / 2 - cb.top };
    };
    const left = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - cb.left, y: r.top + r.height / 2 - cb.top };
    };
    const path = (a, b) => {
      if (!a || !b) return "";
      const dx = Math.max(40, (b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };

    const actorRole = [];
    const rolePerm = [];
    const reject = [];

    RBAC_ACTORS.forEach((a) => {
      const aEl = actorRefs.current[a.id];
      if (a.roles.length === 0) {
        // wires to reject sink (which is rendered to the right of perms)
        const rj = rejectRef.current;
        if (aEl && rj) {
          const aR = right(aEl);
          const rL = left(rj);
          // arc up & out then down to the reject sink
          const dx = (rL.x - aR.x);
          const d = `M ${aR.x} ${aR.y} C ${aR.x + dx * 0.55} ${aR.y}, ${rL.x - dx * 0.45} ${rL.y}, ${rL.x} ${rL.y}`;
          reject.push({ id: `rj-${a.id}`, d, actorId: a.id });
        }
        return;
      }
      a.roles.forEach((rid) => {
        const rEl = roleRefs.current[rid];
        if (!aEl || !rEl) return;
        actorRole.push({
          id: `${a.id}-${rid}`,
          d: path(right(aEl), left(rEl)),
          actorId: a.id, roleId: rid,
          danger: rid === "r4",
        });
      });
    });

    RBAC_ROLES.forEach((r) => {
      const rEl = roleRefs.current[r.id];
      r.perms.forEach((pid) => {
        const pEl = permRefs.current[pid];
        if (!rEl || !pEl) return;
        const perm = RBAC_PERMS.find((x) => x.id === pid);
        rolePerm.push({
          id: `${r.id}-${pid}`,
          d: path(right(rEl), left(pEl)),
          roleId: r.id, permId: pid,
          danger: r.danger || perm?.danger === "high",
        });
      });
    });

    return { actorRole, rolePerm, reject };
  };

  const wires = useRBACMemo(compute, [size.w, size.h]);

  /* Active path resolution from hover */
  const isActive = (which, info) => {
    if (!hover) return false;
    if (hover.kind === "actor") {
      if (which === "ar") return info.actorId === hover.id;
      if (which === "rp") {
        const a = RBAC_ACTORS.find(x => x.id === hover.id);
        return a && a.roles.includes(info.roleId);
      }
      if (which === "rj") return info.actorId === hover.id;
    }
    if (hover.kind === "role") {
      if (which === "ar") return info.roleId === hover.id;
      if (which === "rp") return info.roleId === hover.id;
      return false;
    }
    if (hover.kind === "perm") {
      if (which === "rp") return info.permId === hover.id;
      if (which === "ar") {
        const role = RBAC_ROLES.find(r => r.id === info.roleId);
        return role && role.perms.includes(hover.id);
      }
      return false;
    }
    return false;
  };

  const isDimWire = (which, info) => {
    if (!hover) return false;
    return !isActive(which, info);
  };

  const nodeActive = (kind, id) => {
    if (!hover) return false;
    if (hover.kind === kind && hover.id === id) return true;
    if (hover.kind === "actor" && kind === "role") {
      const a = RBAC_ACTORS.find(x => x.id === hover.id);
      return a && a.roles.includes(id);
    }
    if (hover.kind === "actor" && kind === "perm") {
      const a = RBAC_ACTORS.find(x => x.id === hover.id);
      if (!a) return false;
      const allPerms = new Set();
      a.roles.forEach(rid => {
        const r = RBAC_ROLES.find(x => x.id === rid);
        if (r) r.perms.forEach(p => allPerms.add(p));
      });
      return allPerms.has(id);
    }
    if (hover.kind === "role" && kind === "actor") {
      const a = RBAC_ACTORS.find(x => x.id === id);
      return a && a.roles.includes(hover.id);
    }
    if (hover.kind === "role" && kind === "perm") {
      const r = RBAC_ROLES.find(x => x.id === hover.id);
      return r && r.perms.includes(id);
    }
    if (hover.kind === "perm" && kind === "role") {
      const r = RBAC_ROLES.find(x => x.id === id);
      return r && r.perms.includes(hover.id);
    }
    if (hover.kind === "perm" && kind === "actor") {
      const a = RBAC_ACTORS.find(x => x.id === id);
      if (!a) return false;
      return a.roles.some(rid => {
        const r = RBAC_ROLES.find(x => x.id === rid);
        return r && r.perms.includes(hover.id);
      });
    }
    return false;
  };

  const nodeDim = (kind, id) => hover && !nodeActive(kind, id);

  const handlePermEnter = (perm, e) => {
    setHover({ kind: "perm", id: perm.id });
    const cb = containerRef.current.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setTipPos({
      // place tooltip just above the perm card, aligned to its left edge
      x: Math.min(cb.width - 290, r.left - cb.left),
      y: r.top - cb.top - 8,
      perm,
    });
  };
  const handlePermLeave = () => { setHover(null); setTipPos(null); };

  // Group actors by source for the left column
  const actorsBySource = useRBACMemo(() => {
    const groups = { Telegram: [], Discord: [] };
    RBAC_ACTORS.forEach(a => { (groups[a.source] ||= []).push(a); });
    return groups;
  }, []);

  const rejectedCount = useRBACMemo(
    () => RBAC_ACTORS.filter(a => a.roles.length === 0)
      .reduce((acc, a) => acc + (a.bucketCount || 1), 0),
    []
  );

  return (
    <div className="rbac-graph" ref={containerRef}>
      <svg className="rbac-graph__svg" width={size.w} height={size.h}>
        {wires.reject.map(w => (
          <path
            key={w.id} d={w.d}
            className={`is-reject ${isActive("rj", w) ? "is-active" : ""} ${isDimWire("rj", w) ? "is-dim" : ""}`}
          />
        ))}
        {wires.actorRole.map(w => (
          <path
            key={w.id} d={w.d}
            className={`is-allow ${w.danger ? "is-danger" : ""} ${isActive("ar", w) ? "is-active" : ""} ${isDimWire("ar", w) ? "is-dim" : ""}`}
          />
        ))}
        {wires.rolePerm.map(w => (
          <path
            key={w.id} d={w.d}
            className={`is-allow ${w.danger ? "is-danger" : ""} ${isActive("rp", w) ? "is-active" : ""} ${isDimWire("rp", w) ? "is-dim" : ""}`}
          />
        ))}
      </svg>

      <div className="rbac-graph__cols" ref={colsRef}>
        {/* ACTORS */}
        <div className="rbac-col">
          <div className="rbac-col__head">
            <span className="rbac-col__eyebrow">Actors</span>
            <span className="rbac-col__count">{RBAC_ACTORS.length}</span>
          </div>
          <div className="rbac-col__list">
            {["Telegram", "Discord"].map((src) => (
              <React.Fragment key={src}>
                <div className="rbac-actor-group">
                  {src === "Telegram" ? <I.Telegram size={11} brand /> : <I.Discord size={11} brand />}
                  <span>{src}</span>
                </div>
                {actorsBySource[src].map((a) => {
                  const isReject = a.roles.length === 0;
                  return (
                    <div
                      key={a.id}
                      ref={el => actorRefs.current[a.id] = el}
                      className={`rbac-node ${nodeActive("actor", a.id) ? "is-active" : ""} ${nodeDim("actor", a.id) ? "is-dim" : ""}`}
                      onMouseEnter={() => setHover({ kind: "actor", id: a.id })}
                      onMouseLeave={() => setHover(null)}
                    >
                      <Avatar actor={a} />
                      <div className="rbac-node__main">
                        <div className="rbac-node__name">
                          {a.kind === "bucket" ? a.name : a.name}
                          {a.kind === "bucket" && (
                            <span className="rbac-node__badge">{a.bucketCount}</span>
                          )}
                        </div>
                        <div className="rbac-node__sub">{a.note}</div>
                      </div>
                      {isReject && <span className="rbac-node__badge is-reject">No role</span>}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* ROLES */}
        <div className="rbac-col">
          <div className="rbac-col__head">
            <span className="rbac-col__eyebrow">PwrAgent · Roles (additive)</span>
            <span className="rbac-col__count">{RBAC_ROLES.length}</span>
          </div>
          <div className="rbac-col__list">
            {RBAC_ROLES.map((r) => (
              <div
                key={r.id}
                ref={el => roleRefs.current[r.id] = el}
                className={`rbac-node ${r.danger ? "is-danger" : ""} ${nodeActive("role", r.id) ? "is-active" : ""} ${nodeDim("role", r.id) ? "is-dim" : ""}`}
                onMouseEnter={() => setHover({ kind: "role", id: r.id })}
                onMouseLeave={() => setHover(null)}
              >
                <span className={`rbac-avatar ${r.danger ? "is-bucket" : ""}`} style={r.danger ? {} : { color: "var(--accent-bright)" }}>
                  {r.danger ? <I.AlertTriangle size={14} /> : <I.Lock size={14} />}
                </span>
                <div className="rbac-node__main">
                  <div className="rbac-node__name">{r.name}</div>
                  <div className="rbac-node__sub">{r.sub}</div>
                </div>
                <span className={`rbac-node__badge ${r.builtin ? "is-builtin" : ""} ${r.danger ? "is-danger" : ""}`}>
                  {r.danger ? "Danger" : r.builtin ? "Built-in" : "Custom"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* PERMISSIONS */}
        <div className="rbac-col">
          <div className="rbac-col__head">
            <span className="rbac-col__eyebrow">Permissions</span>
            <span className="rbac-col__count">{RBAC_PERMS.length}</span>
          </div>
          <div className="rbac-col__list">
            {RBAC_PERMS.map((p) => {
              const reach = reverse[p.id].length;
              const wide = p.danger === "high" && reach > 1;
              return (
                <div
                  key={p.id}
                  ref={el => permRefs.current[p.id] = el}
                  className={`rbac-node ${p.danger === "high" ? "is-danger" : ""} ${nodeActive("perm", p.id) ? "is-active" : ""} ${nodeDim("perm", p.id) ? "is-dim" : ""}`}
                  onMouseEnter={(e) => handlePermEnter(p, e)}
                  onMouseLeave={handlePermLeave}
                >
                  <span className={`rbac-avatar ${p.danger === "high" ? "is-bucket" : ""}`} style={p.danger ? {} : { color: "var(--accent-bright)" }}>
                    {p.danger === "high" ? <I.AlertTriangle size={14} /> : p.danger === "med" ? <I.Eye size={14} /> : <I.Check size={13} />}
                  </span>
                  <div className="rbac-node__main">
                    <div className="rbac-node__name">{p.name}</div>
                    <div className="rbac-node__sub">{p.sub}</div>
                  </div>
                  <span className={`rbac-revcount ${wide ? "is-wide" : ""} ${reach === 0 ? "is-zero" : ""}`} title={`${reach} actor(s) currently reach this`}>
                    ↩ {reach}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            ref={rejectRef}
            className="rbac-reject"
            onMouseEnter={() => setHover({ kind: "perm", id: "_reject" })}
            onMouseLeave={() => setHover(null)}
          >
            <span className="rbac-reject__icon"><I.X size={14} /></span>
            <div style={{ flex: 1 }}>
              <div className="rbac-reject__title">End state · Rejected</div>
              <div className="rbac-reject__sub">
                Actors with zero matching roles fall through to a hard reject.
                Messages are dropped, never queued.
              </div>
            </div>
            <span className="rbac-reject__count">{rejectedCount}</span>
          </div>
        </div>
      </div>

      {/* Hover tooltip for permissions */}
      {tipPos && hover?.kind === "perm" && tipPos.perm && (
        <div className="rbac-tip" style={{ left: tipPos.x, top: Math.max(8, tipPos.y - 180) }}>
          <div className="rbac-tip__title">{tipPos.perm.name}</div>
          <div className="rbac-tip__lede">
            Reachable by <b style={{ color: "var(--text-primary)" }}>{reverse[tipPos.perm.id].length}</b> actor{reverse[tipPos.perm.id].length === 1 ? "" : "s"} via{" "}
            <b style={{ color: "var(--text-primary)" }}>
              {new Set(reverse[tipPos.perm.id].map(r => r.role.id)).size}
            </b>{" "}
            role{new Set(reverse[tipPos.perm.id].map(r => r.role.id)).size === 1 ? "" : "s"}.
          </div>
          <div className="rbac-tip__list">
            {reverse[tipPos.perm.id].slice(0, 6).map((row, i) => (
              <div key={i} className="rbac-tip__row">
                <Avatar actor={row.actor} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.actor.name}{row.actor.kind === "bucket" ? ` (${row.actor.bucketCount})` : ""}
                </span>
                <span className="rbac-tip__via">via {row.role.name}</span>
              </div>
            ))}
            {reverse[tipPos.perm.id].length > 6 && (
              <div className="rbac-tip__more">+ {reverse[tipPos.perm.id].length - 6} more — click to inspect</div>
            )}
            {reverse[tipPos.perm.id].length === 0 && (
              <div className="rbac-tip__row" style={{ color: "var(--text-subtle)" }}>No actor currently reaches this.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RBACRoles() {
  const I = window.PA.Icon;
  return (
    <div className="rbac-roles-grid">
      {RBAC_ROLES.map((r) => (
        <div key={r.id} className={`rbac-role-card ${r.danger ? "is-danger" : ""}`}>
          <div className="rbac-role-card__head">
            <span className={`rbac-avatar ${r.danger ? "is-bucket" : ""}`} style={r.danger ? {} : { color: "var(--accent-bright)" }}>
              {r.danger ? <I.AlertTriangle size={14} /> : <I.Lock size={14} />}
            </span>
            <div className="rbac-role-card__name">{r.name}</div>
            <span className={`rbac-node__badge ${r.builtin ? "is-builtin" : ""} ${r.danger ? "is-danger" : ""}`}>
              {r.danger ? "Danger" : r.builtin ? "Built-in" : "Custom"}
            </span>
          </div>
          <div className="rbac-role-card__sub">{r.sub}</div>
          <div className="rbac-role-card__perms">
            {r.perms.map((pid) => {
              const p = RBAC_PERMS.find(x => x.id === pid);
              return (
                <span key={pid} className={`rbac-role-card__perm ${p?.danger === "high" ? "is-danger" : ""}`}>
                  {p?.name}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <div className="rbac-role-card" style={{ alignItems: "center", justifyContent: "center", borderStyle: "dashed", color: "var(--text-muted)", textAlign: "center" }}>
        <I.Plus size={18} />
        <div style={{ font: "600 12px/1.3 var(--font-sans)", color: "var(--text-secondary)" }}>New custom role</div>
        <div style={{ font: "400 11.5px/1.4 var(--font-sans)", color: "var(--text-muted)" }}>
          Compose a profile from individual permissions. Roles are additive — bind multiple to one actor.
        </div>
      </div>
    </div>
  );
}

function RBACPanel() {
  const I = window.PA.Icon;
  const [tab, setTab] = useRBACState("graph");

  return (
    <>
      <div className="pa-settings__head">
        <div className="pa-settings__head-text">
          <div className="pa-settings__head-eyebrow">Access Control</div>
          <h1 className="pa-settings__head-title">Authorization graph</h1>
          <p className="pa-settings__head-help">
            Bind messaging-platform actors (Telegram &amp; Discord users, guild buckets, anything else PwrAgent
            sees) to one or more role profiles. Permissions are <b>strictly additive</b> — if any bound role
            grants a capability, the actor has it. Hover any node to trace the path; hover a permission on the
            right to see every actor that currently reaches it.
          </p>
        </div>
        <button className="pa-btn-strong"><I.Plus size={13} /> New custom role</button>
      </div>

      <div className="rbac-callout">
        <span className="rbac-callout__icon"><I.AlertTriangle size={14} /></span>
        <div>
          <div className="rbac-callout__title">Codex Full Access is escalation-equivalent</div>
          <div className="rbac-callout__body">
            Granting <code>p7 · Codex Full Access</code> gives the actor near-complete control of the host
            machine — arbitrary shell, config writes, and the ability to grant themselves any role on the
            graph below. Treat it like <code>sudo</code>. Audit-log entries for this permission are mandatory
            and cannot be disabled.
          </div>
        </div>
      </div>

      <div className="rbac-tabs">
        <button className={`rbac-tabs__btn ${tab === "graph" ? "is-active" : ""}`} onClick={() => setTab("graph")}>
          <I.Activity size={12} /> Graph
          <span className="rbac-tabs__count">{RBAC_ACTORS.length}/{RBAC_ROLES.length}/{RBAC_PERMS.length}</span>
        </button>
        <button className={`rbac-tabs__btn ${tab === "roles" ? "is-active" : ""}`} onClick={() => setTab("roles")}>
          <I.Lock size={12} /> Roles &amp; profiles
          <span className="rbac-tabs__count">{RBAC_ROLES.length}</span>
        </button>
        <button className={`rbac-tabs__btn ${tab === "audit" ? "is-active" : ""}`} onClick={() => setTab("audit")}>
          <I.Clock size={12} /> Audit
        </button>
      </div>

      {tab === "graph" && (
        <>
          <div className="rbac-toolbar">
            <div className="rbac-legend">
              <span className="rbac-legend__sw"><span className="rbac-legend__line is-allow" /> Allow</span>
              <span className="rbac-legend__sw"><span className="rbac-legend__line is-danger" /> Dangerous path</span>
              <span className="rbac-legend__sw"><span className="rbac-legend__line is-reject" /> Reject (no role)</span>
            </div>
            <span className="rbac-toolbar__sp" />
            <button className="pa-btn-sec"><I.Download size={12} /> Export policy</button>
            <button className="pa-btn-sec"><I.Refresh size={12} /> Re-evaluate</button>
          </div>
          <RBACGraph />
        </>
      )}

      {tab === "roles" && <RBACRoles />}

      {tab === "audit" && (
        <div className="pa-card">
          <div className="pa-card__head">
            <span className="pa-card__eyebrow">Audit</span>
            <h2 className="pa-card__title">Permission decisions</h2>
            <span className="pa-card__chip">last 24h</span>
          </div>
          <div className="pa-card__body" style={{ color: "var(--text-muted)", font: "400 12.5px/1.5 var(--font-sans)" }}>
            Stub — wire up to <code className="pa-md__inline">~/.pwragent/audit.jsonl</code>. Show
            ALLOW / DENY decisions with actor, role(s) consulted, permission, and source line so we can
            answer "why was this allowed?" after the fact.
          </div>
        </div>
      )}
    </>
  );
}

window.PA = window.PA || {};
window.PA.RBACPanel = RBACPanel;
