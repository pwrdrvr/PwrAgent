import { useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
  ResourceActionGate,
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceDomain,
  ResourceScope,
} from "@pwragent/shared/contracts/resource-checkouts";
import { useModalDialog } from "../../lib/useModalDialog";
import { SegmentedControl } from "../settings/SettingsLayout";
import { ResourceActionButton } from "./ResourceActionButton";
import { newResourceActionIdempotencyKey } from "./resource-checkouts-source";
import {
  formatDeadline,
  formatDuration,
  holderLabel,
  type ResourceActionDescriptor,
} from "./resource-view-model";

export type SubmitResourceAction = (
  request: ResourceCheckoutActionRequest,
) => Promise<ResourceCheckoutActionResult>;

/**
 * Retries the original intent after an unknown response. A confirmed result
 * retires the key so the next deliberate attempt is evaluated independently.
 */
function useDialogSubmit(submit: SubmitResourceAction, onDone: () => void) {
  const pending = useRef(new Map<string, ResourceCheckoutActionRequest>());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; unknown: boolean } | null>(null);
  const send = async (
    build: (idempotencyKey: string) => ResourceCheckoutActionRequest,
    intent = "default",
  ) => {
    const request = pending.current.get(intent) ?? build(newResourceActionIdempotencyKey());
    pending.current.set(intent, request);
    setBusy(true);
    setProblem(null);
    const result = await submit(request);
    if (result.outcome !== "unknown") pending.current.delete(intent);
    setBusy(false);
    if (result.outcome === "rejected") {
      setProblem({ text: result.message, unknown: false });
      return;
    }
    if (result.outcome === "unknown") {
      setProblem({
        text: `The authority didn't confirm this. ${result.message} Sending again is safe; it can't apply twice.`,
        unknown: true,
      });
      return;
    }
    onDone();
  };
  return { busy, problem, send };
}

function ResourceDialog(props: {
  titleId: string;
  title: string;
  lede: string;
  busy: boolean;
  problem: { text: string; unknown: boolean } | null;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}): ReactElement {
  const dialogRef = useModalDialog({
    onClose: () => {
      if (!props.busy) props.onClose();
    },
  });
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
        aria-busy={props.busy ? true : undefined}
        aria-labelledby={props.titleId}
        aria-modal="true"
        className={`settings-confirm-dialog resources-dialog${props.wide ? " resources-dialog--wide" : ""}`}
        role="dialog"
      >
        <h2 id={props.titleId}>{props.title}</h2>
        <p>{props.lede}</p>
        {props.children ? <div className="resources-dialog__body">{props.children}</div> : null}
        {props.problem ? (
          <p className="resources-dialog__problem" role="alert">{props.problem.text}</p>
        ) : null}
        <div className="settings-confirm-dialog__actions">{props.footer}</div>
      </div>
    </div>
  );
}

function PolicySummary(props: { resource: ResourceDomain }): ReactElement {
  const { policy } = props.resource;
  return (
    <dl className="resources-pairs resources-dialog__policy">
      <dt>Max hold</dt>
      <dd>{policy.maxHoldMs ? formatDuration(policy.maxHoldMs) : "No limit"}</dd>
      <dt>Cost ceiling</dt>
      <dd>{policy.costCeilingLabel ?? "None"}</dd>
      <dt>At release</dt>
      <dd>{policy.finalEffect}</dd>
    </dl>
  );
}

const DURATION_CHOICES_MS = [15, 30, 45, 60, 120].map((minutes) => minutes * 60_000);

export function RequestCheckoutDialog(props: {
  resource: ResourceDomain;
  action: ResourceActionDescriptor;
  now: number;
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const { resource } = props;
  const maximum = resource.policy.maxHoldMs ?? Infinity;
  const durations = DURATION_CHOICES_MS.filter((ms) => ms <= maximum);
  if (!durations.length) durations.push(maximum);
  const [purpose, setPurpose] = useState("");
  const [duration, setDuration] = useState(durations[Math.min(1, durations.length - 1)]);
  const { busy, problem, send } = useDialogSubmit(props.submit, props.onClose);
  const [unitCount, setUnitCount] = useState("1");
  const units = Number(unitCount);
  const counted = resource.sharing.mode === "counted" ? resource.sharing : undefined;
  const validUnits = !counted || (Number.isSafeInteger(units) && units > 0 && units <= counted.capacity);
  const holder = resource.allocations[0];
  const waits = props.action.waits === true || resource.queue.length > 0
    || (!!counted && units > counted.capacity - counted.inUse);
  const actionLabel = waits ? "Join queue" : "Request checkout";
  return (
    <ResourceDialog
      busy={busy}
      lede={waits
        ? "You'll be added to the end of the queue and woken when it's your turn."
        : "The authority grants it now if capacity is still free, or queues you."}
      problem={problem}
      title={`${actionLabel}: ${resource.displayName}`}
      titleId="resources-request-title"
      onClose={props.onClose}
      footer={(
        <>
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={busy || (!problem?.unknown && (purpose.trim() === "" || !validUnits))}
            type="button"
            onClick={() => void send((idempotencyKey) => ({
              kind: "request",
              idempotencyKey,
              resourceId: resource.resourceId,
              purpose: purpose.trim(),
              expectedDurationMs: duration,
              ...(counted ? { units } : {}),
            }))}
          >
            {busy ? "Sending…" : problem?.unknown ? "Send again" : actionLabel}
          </button>
        </>
      )}
    >
      <label className="resources-field">
        <span>Purpose</span>
        <input
          className="settings-input resources-input"
          placeholder="What the checkout is for"
          type="text"
          value={purpose}
          disabled={busy || problem?.unknown}
          onChange={(event) => setPurpose(event.target.value)}
        />
        <small>Shown to other waiters and kept in the audit record.</small>
      </label>
      {counted ? (
        <div className="resources-field">
          <label htmlFor="resources-request-units">Units</label>
          <input id="resources-request-units" aria-describedby="resources-request-unit-capacity"
            className="settings-input resources-input" type="number" min={1} max={counted.capacity}
            value={unitCount} onChange={(event) => setUnitCount(event.target.value)} disabled={busy || problem?.unknown} />
          <small id="resources-request-unit-capacity">{Math.max(0, counted.capacity - counted.inUse)} of {counted.capacity} units free.</small>
        </div>
      ) : null}
      <div className="resources-field">
        <span>Expected duration</span>
        <SegmentedControl
          label="Expected duration"
          disabled={busy || problem?.unknown}
          options={durations.map((ms) => ({ label: formatDuration(ms), value: ms }))}
          value={duration}
          onChange={setDuration}
        />
      </div>
      <PolicySummary resource={resource} />
      {waits ? (
        <p className="resources-note">
          {resource.queue.length} ahead of you.
          {holder ? ` Current holder: ${holderLabel(holder.holder)}, ${formatDeadline(holder.deadlineAt, props.now)}.` : ""}
        </p>
      ) : null}
    </ResourceDialog>
  );
}

export function ReleaseDialog(props: {
  resource: ResourceDomain;
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const { resource } = props;
  const held = resource.allocations.find((allocation) => allocation.viewerOwns);
  const { busy, problem, send } = useDialogSubmit(props.submit, props.onClose);
  const next = resource.queue[0];
  return (
    <ResourceDialog
      busy={busy}
      lede="Owned work is drained, then the declared cleanup runs."
      problem={problem}
      title={`Release ${resource.displayName}?`}
      titleId="resources-release-title"
      onClose={props.onClose}
      footer={(
        <>
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Keep checkout</button>
          <button
            className="button button--primary"
            disabled={busy || !held}
            type="button"
            onClick={() => held && void send((idempotencyKey) => ({
              kind: "release",
              idempotencyKey,
              resourceId: resource.resourceId,
              allocationId: held.allocationId,
              generation: held.generation,
            }))}
          >
            {busy ? "Releasing…" : problem?.unknown ? "Send again" : "Release"}
          </button>
        </>
      )}
    >
      <dl className="resources-pairs resources-dialog__policy">
        <dt>Cleanup</dt>
        <dd>{resource.policy.finalEffect}</dd>
        <dt>Next waiter</dt>
        <dd>{next ? holderLabel(next.requester) : "None"}</dd>
      </dl>
      <p className="resources-note">
        The resource shows Draining until cleanup is verified. If it can't be verified, it moves to
        Recovery required instead of being handed on.
      </p>
    </ResourceDialog>
  );
}

export function RecoveryDialog(props: {
  resource: ResourceDomain;
  actions: ResourceActionDescriptor[];
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const { resource } = props;
  const recovery = resource.recovery;
  const [note, setNote] = useState("");
  const { busy, problem, send } = useDialogSubmit(props.submit, () => undefined);
  const gateFor = (kind: string): ResourceActionGate | undefined =>
    props.actions.find((action) => action.kind === kind)?.gate;
  const fenceGate = gateFor("fence");
  const verifyGate = gateFor("verify_cleanup");
  const adminGate = gateFor("administrative_release");
  const noteGate: ResourceActionGate | undefined = adminGate?.allowed && note.trim() === ""
    ? { allowed: false, reason: "policy", detail: "Write an audit note first." }
    : adminGate;
  const grantScoped = (kind: "fence" | "verify_cleanup") => recovery && void send((idempotencyKey) => ({
    kind,
    idempotencyKey,
    resourceId: resource.resourceId,
    allocationId: recovery.allocationId,
    generation: recovery.generation,
  }), kind);
  return (
    <ResourceDialog
      wide
      busy={busy}
      lede="Prove the old grant can't act before the resource is handed on."
      problem={problem}
      title={`Recover ${resource.displayName}`}
      titleId="resources-recover-title"
      onClose={props.onClose}
      footer={<button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Close</button>}
    >
      {recovery ? (
        <>
          <dl className="resources-pairs resources-dialog__policy">
            <dt>Grant</dt>
            <dd className="resources-mono">{recovery.allocationId} · g{recovery.generation}</dd>
            <dt>Fencing</dt>
            <dd>{recovery.fencing === "verified" ? "Verified" : "Not verified"}</dd>
            <dt>Evidence</dt>
            <dd>
              <ul className="resources-evidence">
                {recovery.evidence.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </dd>
          </dl>
          <ol className="resources-steps">
            {fenceGate ? (
              <li>
                <ResourceActionButton busy={busy} gate={recovery.fencing === "verified" ? { allowed: false, reason: "not_applicable", detail: "Fencing is already verified." } : fenceGate} onClick={() => grantScoped("fence")}>
                  Fence old workload
                </ResourceActionButton>
                <small>Cancels the old grant's commands and retires its stop guard. Rejected if a newer grant exists.</small>
              </li>
            ) : null}
            {verifyGate ? (
              <li>
                <ResourceActionButton busy={busy} emphasis="primary" gate={verifyGate} onClick={() => grantScoped("verify_cleanup")}>
                  Verify cleanup and release
                </ResourceActionButton>
                <small>Runs the declared cleanup, then wakes the next waiter.</small>
              </li>
            ) : null}
          </ol>
          {adminGate ? (
            <div className="resources-dialog__admin">
              <label className="resources-field">
                <span>Audit note</span>
                <textarea
                  className="settings-input settings-input--multiline resources-input"
                  placeholder="Why the owner can't complete its own cleanup"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <ResourceActionButton
                busy={busy}
                emphasis="danger"
                gate={noteGate ?? adminGate}
                onClick={() => void send((idempotencyKey) => ({
                  kind: "administrative_release",
                  idempotencyKey,
                  resourceId: resource.resourceId,
                  allocationId: recovery.allocationId,
                  generation: recovery.generation,
                  auditNote: note.trim(),
                }), "administrative_release")}
              >
                Administrative release
              </ResourceActionButton>
            </div>
          ) : null}
        </>
      ) : (
        <p className="resources-note">Recovery is complete. This resource is back in normal service.</p>
      )}
    </ResourceDialog>
  );
}

export function ResolveOwnershipDialog(props: {
  resource: ResourceDomain;
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const candidates = props.resource.ownershipConflict?.candidates ?? [];
  const [choice, setChoice] = useState(candidates[0]?.candidateId ?? "");
  const { busy, problem, send } = useDialogSubmit(props.submit, props.onClose);
  return (
    <ResourceDialog
      busy={busy}
      lede="Choose the canonical identity. The other record is retired, not merged, and its profiles must enroll again."
      problem={problem}
      title={`Resolve ownership of ${props.resource.displayName}`}
      titleId="resources-resolve-title"
      onClose={props.onClose}
      footer={(
        <>
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button
            className="button button--secondary resources-button--danger"
            disabled={busy || !choice}
            type="button"
            onClick={() => void send((idempotencyKey) => ({
              kind: "resolve_ownership",
              idempotencyKey,
              resourceId: props.resource.resourceId,
              canonicalCandidateId: choice,
            }))}
          >
            {busy ? "Resolving…" : "Keep selected, retire other"}
          </button>
        </>
      )}
    >
      <SegmentedControl
        label="Canonical identity"
        options={candidates.map((candidate) => ({ label: candidate.label, meta: candidate.detail, value: candidate.candidateId }))}
        value={choice}
        onChange={setChoice}
      />
    </ResourceDialog>
  );
}

export function RegisterResourceDialog(props: {
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [kind, setKind] = useState("Device");
  const [scope, setScope] = useState<ResourceScope>("machine");
  const [sharing, setSharing] = useState<"exclusive" | "counted">("exclusive");
  const [capacity, setCapacity] = useState("2");
  const [instructions, setInstructions] = useState("");
  const { busy, problem, send } = useDialogSubmit(props.submit, props.onClose);
  const capacityValue = Number.parseInt(capacity, 10);
  const valid = name.trim() !== "" && key.trim() !== ""
    && (sharing === "exclusive" || (Number.isInteger(capacityValue) && capacityValue > 0));
  return (
    <ResourceDialog
      wide
      busy={busy}
      lede="Saved as a draft until the registry confirms one canonical record."
      problem={problem}
      title="Register resource"
      titleId="resources-register-title"
      onClose={props.onClose}
      footer={(
        <>
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={busy || !valid}
            type="button"
            onClick={() => void send((idempotencyKey) => ({
              kind: "register_definition",
              idempotencyKey,
              draft: {
                displayName: name.trim(),
                canonicalKey: key.trim(),
                kindLabel: kind.trim() || "Resource",
                allocationScope: scope,
                sharing: sharing === "exclusive"
                  ? { mode: "exclusive" }
                  : { mode: "counted", capacity: capacityValue, inUse: 0, unitLabel: "units" },
                ...(instructions.trim() ? { instructionsSource: instructions.trim() } : {}),
              },
            }))}
          >
            {busy ? "Saving…" : "Save draft"}
          </button>
        </>
      )}
    >
      <label className="resources-field">
        <span>Name</span>
        <input className="settings-input resources-input" type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="resources-field">
        <span>Canonical identity</span>
        <input className="settings-input" placeholder="device:<machine>/<port>" type="text" value={key} onChange={(event) => setKey(event.target.value)} />
        <small>Use an immutable identifier. Hostnames and IP addresses aren't identities.</small>
      </label>
      <label className="resources-field">
        <span>Kind</span>
        <input className="settings-input resources-input" type="text" value={kind} onChange={(event) => setKind(event.target.value)} />
      </label>
      <div className="resources-field">
        <span>Allocation scope</span>
        <SegmentedControl
          label="Allocation scope"
          options={[
            { label: "This instance", value: "instance" },
            { label: "This machine", value: "machine" },
            { label: "Federation", value: "federation" },
          ]}
          value={scope}
          onChange={setScope}
        />
      </div>
      <div className="resources-field">
        <span>Sharing</span>
        <SegmentedControl
          label="Sharing"
          options={[{ label: "Exclusive", value: "exclusive" }, { label: "Counted", value: "counted" }]}
          value={sharing}
          onChange={setSharing}
        />
      </div>
      {sharing === "counted" ? (
        <label className="resources-field">
          <span>Capacity</span>
          <input className="settings-input settings-input--inline" inputMode="numeric" type="text" value={capacity} onChange={(event) => setCapacity(event.target.value)} />
        </label>
      ) : null}
      <label className="resources-field">
        <span>Instructions</span>
        <input className="settings-input" placeholder="Skill or resource notes" type="text" value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        <small>Agents read these. They can't grant permissions.</small>
      </label>
    </ResourceDialog>
  );
}
