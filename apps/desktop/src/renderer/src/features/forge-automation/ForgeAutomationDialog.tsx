import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  resolveProjectForgeAutomation,
  type ProjectForgeAutomation,
  type ProjectHeldWakeup,
} from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";
import { SegmentedControl } from "../settings/SettingsLayout";
import { formatForgeAutomationTime, formatHeldWakeupCount } from "./forge-automation-view";

export type ForgeAutomationDialogProps = {
  projectLabel: string;
  /** The project's forge repository, else its path. */
  projectDetail?: string;
  /** What the owner stored. Absent means the defaults. */
  automation: ProjectForgeAutomation | undefined;
  /** Where focus goes on close when the opener is gone, as from a menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Read once as the dialog opens on a paused project, for its status line. */
  listHeldWakeups?: () => Promise<ProjectHeldWakeup[]>;
  onCancel: () => void;
  /** Rejects with a message to show in the dialog. */
  onSubmit: (automation: ProjectForgeAutomation) => Promise<void>;
  /** Clock for the status line. Defaults to `Date.now`. */
  now?: () => number;
};

type ForgeActivity = "active" | "paused";

/**
 * Per-project Forge Automation (design 2a): pause the project's forge
 * activity, or keep it active and turn off individual kinds of automatic
 * turn. Explicit Save, like Lock Thread. Mounted only while open and
 * portalled to the body.
 */
export function ForgeAutomationDialog(props: ForgeAutomationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const optionId = useId();
  const stored = resolveProjectForgeAutomation(props.automation);
  const [draft, setDraft] = useState<ProjectForgeAutomation>(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const heldCount = useHeldWakeupCount(stored.paused ? props.listHeldWakeups : undefined);
  const dialogRef = useModalDialog<HTMLElement>({
    // A save in flight cannot be called back, so the dialog waits for it.
    onClose: () => {
      if (!busy) props.onCancel();
    },
    ...(props.returnFocus ? { returnFocus: props.returnFocus } : {}),
  });
  const activity: ForgeActivity = draft.paused ? "paused" : "active";

  const update = (patch: Partial<ProjectForgeAutomation>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(undefined);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    // A pause that continues keeps the time it began.
    const { pausedAt: _pausedAt, ...rest } = draft;
    const pausedAt = stored.paused && stored.pausedAt
      ? stored.pausedAt
      : props.now?.() ?? Date.now();
    const next: ProjectForgeAutomation = draft.paused
      ? { ...rest, paused: true, pausedAt }
      : { ...rest, paused: false };
    try {
      await props.onSubmit(next);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  const option = (params: {
    id: string;
    type: "checkbox" | "radio";
    title: string;
    description: string;
    checked: boolean;
    onChange: () => void;
  }): ReactNode => (
    <label className="forge-automation-dialog__option">
      <input
        aria-describedby={`${params.id}-description`}
        aria-labelledby={`${params.id}-title`}
        checked={params.checked}
        disabled={busy}
        name={params.type === "radio" ? `${optionId}-wakeups` : undefined}
        type={params.type}
        onChange={params.onChange}
      />
      <span className="forge-automation-dialog__option-text">
        <span id={`${params.id}-title`}>{params.title}</span>
        <small id={`${params.id}-description`}>{params.description}</small>
      </span>
    </label>
  );

  const pausedSince = stored.paused && stored.pausedAt
    ? `Paused since ${formatForgeAutomationTime(stored.pausedAt, props.now?.() ?? Date.now())}`
    : stored.paused ? "Paused" : undefined;

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section
        ref={dialogRef}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="rename-thread-dialog forge-automation-dialog"
        role="dialog"
      >
        <h2 id={titleId}>Forge Automation</h2>
        <p className="forge-automation-dialog__subtitle">
          {props.projectDetail ? `${props.projectLabel} · ${props.projectDetail}` : props.projectLabel}
        </p>
        <p id={descriptionId} className="forge-automation-dialog__lede">
          What this project's pull requests may do to its threads. Your own messages and messaging apps are never blocked.
        </p>
        <div className="forge-automation-dialog__group">
          <p aria-hidden="true" className="forge-automation-dialog__label">Forge activity</p>
          <SegmentedControl<ForgeActivity>
            disabled={busy}
            label="Forge activity"
            options={[
              { label: "Active", value: "active" },
              { label: "Paused", value: "paused" },
            ]}
            value={activity}
            onChange={(value) => update({ paused: value === "paused" })}
          />
          {draft.paused ? (
            <p className="forge-automation-dialog__hint">
              PwrAgent stops checking this project's pull requests. PR chips keep their last status, and nothing from the forge starts a turn.
            </p>
          ) : null}
        </div>
        {draft.paused ? (
          <div className="forge-automation-dialog__group">
            <p className="forge-automation-dialog__label">While paused</p>
            {option({
              id: `${optionId}-refuse`,
              type: "checkbox",
              title: "Refuse messages from other threads",
              description: "The sending agent is told this project is paused.",
              checked: draft.refuseThreadMessages,
              onChange: () => update({ refuseThreadMessages: !draft.refuseThreadMessages }),
            })}
            <fieldset
              aria-describedby={`${optionId}-wakeups-hint`}
              className="forge-automation-dialog__fieldset"
            >
              <legend className="forge-automation-dialog__label">Wake-ups that still arrive</legend>
              <p id={`${optionId}-wakeups-hint`} className="forge-automation-dialog__hint forge-automation-dialog__hint--lead">
                A monitor that finishes, or a thread this one is waiting on.
              </p>
              {option({
                id: `${optionId}-hold`,
                type: "radio",
                title: "Hold for review",
                description: "Kept in the thread as a held message. Resuming lists them.",
                checked: draft.wakeupPolicy === "hold",
                onChange: () => update({ wakeupPolicy: "hold" }),
              })}
              {option({
                id: `${optionId}-discard`,
                type: "radio",
                title: "Discard",
                description: "Dropped, with a note in the thread.",
                checked: draft.wakeupPolicy === "discard",
                onChange: () => update({ wakeupPolicy: "discard" }),
              })}
            </fieldset>
          </div>
        ) : (
          <fieldset className="forge-automation-dialog__group forge-automation-dialog__fieldset">
            <legend className="forge-automation-dialog__label">Start turns automatically for</legend>
            {option({
              id: `${optionId}-conflicts`,
              type: "checkbox",
              title: "Merge conflicts",
              description: "Auto-fix rebases a PR that can no longer merge.",
              checked: draft.autoFixMergeConflicts,
              onChange: () => update({ autoFixMergeConflicts: !draft.autoFixMergeConflicts }),
            })}
            {option({
              id: `${optionId}-ci`,
              type: "checkbox",
              title: "Failing CI",
              description: "Auto-fix repairs a failed check on the PR's head commit.",
              checked: draft.autoFixCiFailures,
              onChange: () => update({ autoFixCiFailures: !draft.autoFixCiFailures }),
            })}
            {option({
              id: `${optionId}-watches`,
              type: "checkbox",
              title: "PR watches",
              description: "An agent asked to be woken when CI finishes or the PR merges or closes.",
              checked: draft.prWatches,
              onChange: () => update({ prWatches: !draft.prWatches }),
            })}
            <p className="forge-automation-dialog__hint">
              These only turn things off for this project. A thread whose own Auto-fix is off stays off.
            </p>
          </fieldset>
        )}
        {pausedSince && draft.paused ? (
          <p className="forge-automation-dialog__status" role="status">
            {heldCount === undefined ? pausedSince : `${pausedSince} · ${formatHeldWakeupCount(heldCount)}`}
          </p>
        ) : null}
        {error ? (
          <p className="rename-thread-dialog__error" role="alert">{error}</p>
        ) : null}
        <div className="rename-thread-dialog__actions">
          <button
            className="button button--secondary"
            disabled={busy}
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void submit()}
          >
            Save
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * How many wake-ups the paused project holds, read once as the dialog opens.
 * Undefined until it arrives, and when the read fails: the status line then
 * says only when the pause began.
 */
function useHeldWakeupCount(
  list: (() => Promise<ProjectHeldWakeup[]>) | undefined,
): number | undefined {
  const [count, setCount] = useState<number>();
  // Once per open: the caller may pass a fresh function each render.
  const listRef = useRef(list);
  useEffect(() => {
    const read = listRef.current;
    if (!read) return;
    let cancelled = false;
    read()
      .then((wakeups) => {
        if (!cancelled) setCount(wakeups.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return count;
}
