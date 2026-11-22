import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_TRUST_PROVIDERS,
  MAX_AGENT_TRUST_ACTOR_REQUIREMENTS,
  MAX_AGENT_TRUST_RULES,
  isAgentTrustPolicy,
  type AgentTrustActorRequirement,
  type AgentTrustConversation,
  type AgentTrustPolicy,
  type AgentTrustRule,
} from "@pwragent/shared/contracts/agent-trust-policy";
import type { MessagingActivityEntry } from "@pwragent/shared/contracts/messaging";
import type { ThreadAgentTrustPolicyTarget } from "@pwragent/shared/contracts/navigation";
import { Select } from "../../../components/Select";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useModalDialog } from "../../../lib/useModalDialog";
import "./agent-messaging-trust.css";

const PROVIDERS = AGENT_TRUST_PROVIDERS.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const CONVERSATIONS = [
  { value: "any", label: "Any admitted conversation" },
  { value: "dm", label: "Direct message" },
  { value: "channel", label: "Channel" },
  { value: "thread", label: "Thread" },
  { value: "topic", label: "Topic" },
] as const;
const REQUIREMENTS = [
  { value: "actor-id", label: "Provider user ID" },
  { value: "rbac-role", label: "Access Control role ID" },
  { value: "provider-property", label: "Slack workspace administrator" },
] as const;
const REJECTION_LABELS: Record<string, string> = {
  "invalid-policy": "Policy could not be read",
  platform: "Provider",
  connection: "Connection",
  conversation: "Conversation",
  actor: "User or Access Control role",
  "actor-property": "Workspace administrator evidence unavailable",
  "no-rules": "No allow rules",
  "remote-owner": "Remote invocation",
};

type TrustApi = Pick<DesktopApi, "readThreadAgentTrustPolicy" | "setThreadAgentTrustPolicy" | "listMessagingActivity">;
type DraftRule = { id: number; rule: AgentTrustRule };

export function AgentMessagingTrust(props: {
  target: ThreadAgentTrustPolicyTarget;
  revision: number;
  api: TrustApi;
  refresh?: () => Promise<void>;
}) {
  const { backend, threadId } = props.target;
  const read = props.api.readThreadAgentTrustPolicy;
  const save = props.api.setThreadAgentTrustPolicy;
  const [snapshot, setSnapshot] = useState<{ policy?: unknown }>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!read) return;
    let active = true;
    void read({ backend, threadId }).then((value) => {
      if (active) { setSnapshot(value); setError(undefined); }
    }, (readError: unknown) => {
      if (active) setError(readError instanceof Error ? readError.message : String(readError));
    });
    return () => { active = false; };
  }, [backend, threadId, read, props.revision]);

  if (!read || !save) return null;
  const policy = snapshot?.policy;
  const status = error ? "Unavailable" : !snapshot ? "Reading policy…" : policy === undefined ? "Inherited"
    : !isAgentTrustPolicy(policy) ? "Restricted · unreadable policy" : policy.rules.length === 0 ? "Restricted · no rules"
    : `Restricted · ${policy.rules.length} ${policy.rules.length === 1 ? "rule" : "rules"}`;

  return (
    <div className="context-list__item">
      <div className="context-list__content">
        <p className="context-list__label">Messaging access</p>
        <p className="context-list__meta" title={error}>{status}</p>
      </div>
      <button className="context-list__action" type="button" disabled={!snapshot || !!error} onClick={() => setOpen(true)}>Edit access</button>
      {open ? <TrustDialog policy={policy} listActivity={props.api.listMessagingActivity} target={props.target}
        onClose={() => setOpen(false)} onSave={async (next) => {
          const saved = await save({ backend, threadId, policy: next });
          setSnapshot({ policy: saved ?? undefined });
          setOpen(false);
          void props.refresh?.();
        }} /> : null}
    </div>
  );
}

function TrustDialog(props: {
  policy: unknown;
  target: ThreadAgentTrustPolicyTarget;
  listActivity: TrustApi["listMessagingActivity"];
  onSave: (policy: AgentTrustPolicy | null) => Promise<void>;
  onClose: () => void;
}) {
  const valid = isAgentTrustPolicy(props.policy) ? props.policy : undefined;
  const [mode, setMode] = useState<"inherited" | "restricted">(props.policy === undefined ? "inherited" : "restricted");
  const [rules, setRules] = useState<DraftRule[]>(() => (valid?.rules ?? []).map((rule, id) => ({ rule, id })));
  const nextRule = useRef(rules.length);
  const [denialResponse, setDenialResponse] = useState<AgentTrustPolicy["denialResponse"]>(valid?.denialResponse ?? "silent");
  const [busy, setBusy] = useState(false);
  const [savingError, setSavingError] = useState<string>();
  const [confirmInherit, setConfirmInherit] = useState(false);
  const [replaceUnreadable, setReplaceUnreadable] = useState(false);
  const [activity, setActivity] = useState<MessagingActivityEntry[]>();
  const [activityError, setActivityError] = useState(false);
  const title = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useModalDialog({ onClose: () => { if (!busy) props.onClose(); }, initialFocus: closeRef });
  const target = props.target;
  const listActivity = props.listActivity;
  const unreadable = props.policy !== undefined && !valid;
  const draft: AgentTrustPolicy = { version: 1, denialResponse, rules: rules.map(({ rule }) => rule) };

  useEffect(() => {
    if (!listActivity) return;
    let active = true;
    void listActivity({ limit: 500 }).then(({ entries }) => {
      if (active) setActivity(entries.filter((entry) => entry.backend === target.backend
        && entry.threadId === target.threadId && entry.payload?.rejectionStage === "agent-trust"
        && entry.payload?.rejectionReason !== "remote-owner").slice(0, 5));
    }, () => { if (active) setActivityError(true); });
    return () => { active = false; };
  }, [listActivity, target.backend, target.threadId]);

  async function save(): Promise<void> {
    if (mode === "inherited" && props.policy !== undefined && !confirmInherit) { setConfirmInherit(true); return; }
    setBusy(true);
    setSavingError(undefined);
    try { await props.onSave(mode === "restricted" ? draft : null); }
    catch (error) { setSavingError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function updateRule(id: number, rule: AgentTrustRule): void {
    setRules((previous) => previous.map((entry) => entry.id === id ? { id, rule } : entry));
  }

  return createPortal(
    <div className="subagent-modal" role="dialog" aria-modal="true" aria-labelledby={title}>
      <div ref={contentRef} className="subagent-modal__content agent-trust-dialog">
        <div className="subagent-modal__head">
          <h2 className="subagent-modal__title" id={title}>Messaging access</h2>
        </div>
        <div className="subagent-modal__body agent-trust-dialog__body">
          <Field label="Invocation policy">
            <Select disabled={busy} value={mode} onChange={(value) => { setMode(value); setConfirmInherit(false); }} options={[
              { value: "inherited", label: "Inherited" }, { value: "restricted", label: "Restricted" },
            ]} />
          </Field>
          {mode === "inherited" ? <p>Provider admission, Access Control, and inbound Automation filters apply.</p> : <>
            <p>{rules.length === 0 ? "All messaging invocations are blocked until a rule matches." : "One rule must match. Every condition within that rule must match."}</p>
            {unreadable && !replaceUnreadable ? (
              <div>
                <p>The current policy is unreadable and blocks messaging invocations.</p>
                <button className="button button--ghost" type="button" onClick={() => setReplaceUnreadable(true)}>Replace with a new restriction</button>
              </div>
            ) : <>
              {rules.map(({ id, rule }, index) => <RuleFields key={id} rule={rule} index={index} busy={busy}
                change={(next) => updateRule(id, next)} remove={() => setRules((previous) => previous.filter((entry) => entry.id !== id))} />)}
              <div><button className="button button--ghost" disabled={busy || rules.length >= MAX_AGENT_TRUST_RULES} type="button" onClick={() => {
                const id = nextRule.current++;
                setRules((previous) => [...previous, { id, rule: { provider: "slack", allOf: [{ kind: "actor-id", actorId: "" }] } }]);
              }}>Add allow rule</button></div>
            </>}
            <Field label="When a request is declined">
              <Select disabled={busy} value={denialResponse} onChange={setDenialResponse} options={[
                { value: "silent", label: "Say nothing" }, { value: "generic", label: "Send a generic reply" },
              ]} />
            </Field>
            {denialResponse === "generic" ? <p>Automation-only messages are always declined silently.</p> : null}
          </>}
          {listActivity ? <section className="agent-trust-dialog__evidence">
            <h3>Recent trust rejections</h3>
            {activityError ? <p>Couldn’t read recent activity.</p> : !activity ? <p>Reading activity…</p> : activity.length === 0
              ? <p>No trust rejections in recent activity.</p> : <ul>
                {activity.map((entry) => <li key={entry.id}>
                  <strong>{REJECTION_LABELS[String(entry.payload?.rejectionReason)] ?? "Trust check declined"}</strong>
                  <span>{entry.platform} · {entry.conversationId} · {new Date(entry.createdAt).toLocaleString()}</span>
                </li>)}
              </ul>}
          </section> : null}
          {confirmInherit ? <p role="alert">Restoring inherited access removes this Agent’s restrictions. Select Restore inherited access to confirm.</p> : null}
          {savingError ? <p role="alert">{savingError}</p> : null}
        </div>
        <div className="decisions-setup__foot">
          <button ref={closeRef} className="button button--ghost" type="button" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button className="button button--primary" type="button" disabled={busy || (mode === "restricted" && (!isAgentTrustPolicy(draft) || unreadable && !replaceUnreadable))}
            onClick={() => void save()}>{busy ? "Saving…" : confirmInherit ? "Restore inherited access" : "Save"}</button>
        </div>
      </div>
    </div>, document.body,
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="agent-trust-field"><span>{label}</span>{children}</label>;
}

function RuleFields(props: {
  rule: AgentTrustRule;
  index: number;
  busy: boolean;
  change: (rule: AgentTrustRule) => void;
  remove: () => void;
}) {
  const { rule, busy, change } = props;
  const [nextRequirement, setNextRequirement] = useState(rule.allOf.length);
  const [requirementIds, setRequirementIds] = useState(() => rule.allOf.map((_, index) => index));
  const editConversation = (update: Partial<AgentTrustConversation>) => {
    if (rule.conversation) change({ ...rule, conversation: { ...rule.conversation, ...update } });
  };
  function editRequirement(index: number, next: AgentTrustActorRequirement): void {
    change({ ...rule, allOf: rule.allOf.map((requirement, current) => current === index ? next : requirement) });
  }
  return <fieldset className="agent-trust-rule" disabled={busy}>
    <legend>{props.index === 0 ? "Allow when" : "Or allow when"}</legend>
    <Field label="Provider">
      <Select value={rule.provider} options={PROVIDERS} disabled={busy || Boolean(rule.connectionId)} onChange={(provider) => change({
        ...rule, provider, conversation: undefined,
        allOf: rule.allOf.map((requirement) => requirement.kind === "rbac-role" ? { kind: "rbac-role", roleId: "" } : { kind: "actor-id", actorId: "" }),
      })} />
    </Field>
    {rule.connectionId ? <p>Connection {rule.connectionId}</p> : null}
    <Field label="Conversation">
      <Select value={rule.conversation?.kind ?? "any"} options={CONVERSATIONS} disabled={busy} onChange={(kind) => change({
        ...rule, conversation: kind === "any" ? undefined : { kind, id: "" },
      })} />
    </Field>
    {rule.conversation ? <div className="agent-trust-rule__references">
      <Field label="Conversation ID"><input value={rule.conversation.id} onChange={(event) => editConversation({ id: event.target.value })} /></Field>
      <Field label="Parent ID, if present"><input value={rule.conversation.parentId ?? ""} onChange={(event) => editConversation({ parentId: event.target.value || undefined })} /></Field>
      <Field label="Workspace ID, if present"><input value={rule.conversation.workspaceId ?? ""} onChange={(event) => editConversation({ workspaceId: event.target.value || undefined })} /></Field>
    </div> : null}
    {rule.allOf.map((requirement, index) => <div className="agent-trust-rule__requirement" key={requirementIds[index]}>
      <Field label="Actor condition">
        <Select value={requirement.kind} disabled={busy} options={rule.provider === "slack" ? REQUIREMENTS : REQUIREMENTS.slice(0, 2)}
          onChange={(kind) => editRequirement(index, kind === "actor-id" ? { kind, actorId: "" }
            : kind === "rbac-role" ? { kind, roleId: "" } : { kind, key: "slack.workspace-admin", value: true })} />
      </Field>
      {requirement.kind === "actor-id" ? <Field label="Provider user ID"><input value={requirement.actorId} onChange={(event) => editRequirement(index, { ...requirement, actorId: event.target.value })} /></Field> : null}
      {requirement.kind === "rbac-role" ? <Field label="Access Control role ID"><input value={requirement.roleId} onChange={(event) => editRequirement(index, { ...requirement, roleId: event.target.value })} /></Field> : null}
      {requirement.kind === "provider-property" ? <p>Slack must confirm this role for the actor in the workspace.</p> : null}
      {rule.allOf.length > 1 ? <button className="button button--ghost" type="button" onClick={() => {
        setRequirementIds((previous) => previous.filter((_, current) => current !== index));
        change({ ...rule, allOf: rule.allOf.filter((_, current) => current !== index) });
      }}>Remove condition</button> : null}
    </div>)}
    <div className="agent-trust-rule__actions">
      <button className="button button--ghost" type="button" disabled={rule.allOf.length >= MAX_AGENT_TRUST_ACTOR_REQUIREMENTS} onClick={() => {
        setRequirementIds((previous) => [...previous, nextRequirement]);
        setNextRequirement(nextRequirement + 1);
        change({ ...rule, allOf: [...rule.allOf, { kind: "actor-id", actorId: "" }] });
      }}>Add condition</button>
      <button className="button button--ghost" type="button" onClick={props.remove}>Remove rule</button>
    </div>
  </fieldset>;
}
