import { useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  CANONICAL_RESOURCE_KEY_EXAMPLE,
  canonicalResourceKeyProblem,
  type ResourceActionGate,
  type ResourceCheckoutActionRequest,
  type ResourceCheckoutActionResult,
  type ResourceDomain,
  type ResourceRecoveryActionGates,
  type ResourceRecoveryStatus,
  type ResourceScope,
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

/**
 * A labelled text input whose hint and problem are its description, not part
 * of its name, so assistive technology announces the name alone first.
 */
function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  problem?: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const describedBy = [props.hint ? hintId : undefined, props.problem ? problemId : undefined].filter(Boolean).join(" ");
  return (
    <div className="resources-field">
      <label htmlFor={id}>{props.label}</label>
      <input
        aria-describedby={describedBy || undefined}
        aria-invalid={props.problem ? true : undefined}
        className={props.mono ? "settings-input" : "settings-input resources-input"}
        disabled={props.disabled}
        id={id}
        placeholder={props.placeholder}
        type="text"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint ? <small id={hintId}>{props.hint}</small> : null}
      {props.problem ? <small className="resources-field__problem" id={problemId}>{props.problem}</small> : null}
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
  const counted = resource.sharing.mode === "counted" ? resource.sharing : undefined;
  const machinePool = !!counted && resource.placement === "machine";
  const [slotMode, setSlotMode] = useState<"all" | "partial">(machinePool ? "all" : "partial");
  const [unitCount, setUnitCount] = useState("1");
  const units = slotMode === "all" ? counted!.capacity : Number(unitCount);
  const validUnits = !counted || (Number.isSafeInteger(units) && units > 0 && units <= counted.capacity);
  const holder = resource.allocations[0];
  const waits = props.action.waits === true
    || (!!counted && units > counted.capacity - counted.inUse);
  const actionLabel = waits ? "Join queue" : "Request checkout";
  return (
    <ResourceDialog
      busy={busy}
      lede="The authority grants the request if capacity and scheduling allow. Otherwise it joins the queue."
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
              ...(counted && slotMode === "partial" ? { units } : {}),
            }))}
          >
            {busy ? "Sending…" : problem?.unknown ? "Send again" : actionLabel}
          </button>
        </>
      )}
    >
      <TextField
        disabled={busy || problem?.unknown}
        hint="Shown to other waiters and kept in the audit record."
        label="Purpose"
        placeholder="What the checkout is for"
        value={purpose}
        onChange={setPurpose}
      />
      {counted ? (
        <div className="resources-field">
          {machinePool && counted.capacity > 1 ? (
            <SegmentedControl
              label="CPU reservation"
              options={[{ label: "All CPU slots", value: "all" }, { label: "Choose slots", value: "partial" }]}
              value={slotMode}
              onChange={setSlotMode}
              disabled={busy || problem?.unknown}
            />
          ) : null}
          {slotMode === "partial" ? (
            <>
              <label htmlFor="resources-request-units">{machinePool ? "CPU slots" : "Units"}</label>
              <input id="resources-request-units" aria-describedby="resources-request-unit-capacity"
                className="settings-input resources-input" type="number" min={1} max={counted.capacity}
                value={unitCount} onChange={(event) => setUnitCount(event.target.value)} disabled={busy || problem?.unknown} />
            </>
          ) : null}
          <small id="resources-request-unit-capacity">
            {Math.max(0, counted.capacity - counted.inUse)} of {counted.capacity} {machinePool ? "CPU slots" : "units"} free.
            {slotMode === "all" ? " Reserves the whole machine pool." : ""}
          </small>
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
      {waits || resource.queue.length > 0 ? (
        <p className="resources-note">
          {resource.queue.length} currently waiting.
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

export function ResolveOwnershipDialog(props: {
  resource: ResourceDomain;
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const { resource } = props;
  const conflict = resource.ownershipConflict;
  const resolution = conflict?.resolution;
  const { busy, problem, send } = useDialogSubmit(props.submit, props.onClose);
  return (
    <ResourceDialog
      busy={busy}
      lede={conflict?.reason ?? "This resource's ownership is unresolved."}
      problem={problem}
      title={`Resolve ownership of ${resource.displayName}?`}
      titleId="resources-resolve-title"
      onClose={props.onClose}
      footer={(
        <>
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={busy || !resolution}
            type="button"
            onClick={() => resolution && void send((idempotencyKey) => ({
              kind: "resolve_ownership",
              idempotencyKey,
              resourceId: resource.resourceId,
              resolution: resolution.kind,
            }))}
          >
            {busy ? "Resolving…" : problem?.unknown ? "Send again" : (resolution?.label ?? "Resolve")}
          </button>
        </>
      )}
    >
      {resolution ? <p className="resources-note">{resolution.consequence}</p> : null}
      <p className="resources-note">
        Checkouts are cooperative. If this turns out wrong, work can overlap until the affected leases end.
      </p>
    </ResourceDialog>
  );
}

export function RecoveryDialog(props: {
  resource: ResourceDomain;
  recovery: ResourceRecoveryStatus | undefined;
  actions: ResourceRecoveryActionGates;
  submit: SubmitResourceAction;
  onClose: () => void;
}): ReactElement {
  const { resource, recovery } = props;
  const [note, setNote] = useState("");
  const { busy, problem, send } = useDialogSubmit(props.submit, () => undefined);
  const { fence: fenceGate, verify_cleanup: verifyGate, administrative_release: adminGate } = props.actions;
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
      lede="Verify that this allocation can no longer act before releasing its slots."
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
                <small>{resource.placement === "machine"
                  ? "Checks that this allocation's recorded process group is gone."
                  : "Checks that commands and stop guards from this allocation can no longer act."}</small>
              </li>
            ) : null}
            {verifyGate ? (
              <li>
                <ResourceActionButton busy={busy} emphasis="primary" gate={verifyGate} onClick={() => grantScoped("verify_cleanup")}>
                  Verify cleanup and release
                </ResourceActionButton>
                <small>Rechecks cleanup for this allocation. The queue waits until all recoveries are resolved.</small>
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
        <p className="resources-note">This allocation no longer needs recovery.</p>
      )}
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
  // Checked as the operator types, by the same rule the authority applies.
  const keyProblem = key.trim() === "" ? undefined : canonicalResourceKeyProblem(key.trim());
  const valid = name.trim() !== "" && key.trim() !== "" && !keyProblem
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
      <TextField label="Name" value={name} onChange={setName} />
      <TextField
        mono
        hint="Use an identifier that doesn't change. Hostnames and IP addresses aren't identities."
        label="Canonical identity"
        placeholder={CANONICAL_RESOURCE_KEY_EXAMPLE}
        problem={keyProblem}
        value={key}
        onChange={setKey}
      />
      <TextField label="Kind" value={kind} onChange={setKind} />
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
      <TextField
        mono
        hint="Agents read these. They can't grant permissions."
        label="Instructions"
        placeholder="Skill or resource notes"
        value={instructions}
        onChange={setInstructions}
      />
    </ResourceDialog>
  );
}
