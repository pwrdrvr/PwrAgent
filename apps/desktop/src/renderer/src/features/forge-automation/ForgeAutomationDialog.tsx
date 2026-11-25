import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  MAX_HANDS_OFF_RULE_TEXT,
  MAX_HANDS_OFF_RULES,
  MAX_PROJECT_MERGE_BRANCHES,
  normalizeHandsOffRepository,
  normalizeHandsOffRules,
  normalizeProjectMergeBranch,
  resolveProjectForgeAutomation,
  type ProjectForgeAutomation,
  type ProjectForgeHandsOffRule,
  type ProjectHeldWakeup,
  type ProjectMergeBuildWatches,
} from "@pwragent/shared/project-forge-automation";
import { CloseIcon } from "../../icons/CloseIcon";
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
  /**
   * The project's remote repositories, `owner/name`, offered as one-click
   * picks for a hands-off rule: a fork's upstream is one.
   */
  repositorySuggestions?: readonly string[];
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
  const [branchInput, setBranchInput] = useState("");
  const [branchError, setBranchError] = useState<string>();
  const branchInputRef = useRef<HTMLInputElement>(null);
  // Bumped by a removal: its button unmounts, so focus moves to the field.
  const [branchRemovals, setBranchRemovals] = useState(0);
  useEffect(() => {
    if (branchRemovals > 0) branchInputRef.current?.focus();
  }, [branchRemovals]);
  const mergeBranches = draft.mergeBranches ?? [];
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

  const setHandsOff = (rules: ProjectForgeHandsOffRule[]) => {
    // Stored only when it holds a rule, as the owner stores it.
    update({ handsOff: rules.length > 0 ? rules : undefined });
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    // A pause that continues keeps the time it began. The branch list is
    // kept only with Never merge on, and only when it lists a branch.
    const { pausedAt: _pausedAt, mergeBranches: draftBranches, ...unbranched } = draft;
    const rest: ProjectForgeAutomation = draft.neverMerge && draftBranches?.length
      ? { ...unbranched, mergeBranches: draftBranches }
      : unbranched;
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

  const addBranch = () => {
    const branch = normalizeProjectMergeBranch(branchInput);
    if (!branch) {
      setBranchError(branchInput.trim()
        ? "Enter one branch name, without spaces, of at most 255 characters."
        : undefined);
      return;
    }
    if (mergeBranches.includes(branch)) {
      setBranchError(`${branch} is already listed.`);
      return;
    }
    update({ mergeBranches: [...mergeBranches, branch] });
    setBranchInput("");
    setBranchError(undefined);
  };

  const removeBranch = (branch: string) => {
    const next = mergeBranches.filter((entry) => entry !== branch);
    update({ mergeBranches: next.length ? next : undefined });
    setBranchRemovals((count) => count + 1);
  };

  const branchesFull = mergeBranches.length >= MAX_PROJECT_MERGE_BRANCHES;

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
        {draft.paused ? null : (
          <HandsOffRules
            busy={busy}
            rules={draft.handsOff ?? []}
            suggestions={props.repositorySuggestions ?? []}
            onChange={setHandsOff}
          />
        )}
        {draft.paused ? null : (
          <fieldset className="forge-automation-dialog__group forge-automation-dialog__fieldset">
            <legend className="forge-automation-dialog__label">To-do cards</legend>
            {option({
              id: `${optionId}-offers`,
              type: "checkbox",
              title: draft.neverMerge && !mergeBranches.length ? "Review offers" : "Review and merge offers",
              description: draft.neverMerge && !mergeBranches.length
                ? "A Review card when CI passes on unreviewed changes."
                : "A Review card when CI passes on unreviewed changes, then a Merge card once the review is settled.",
              checked: draft.prOffers,
              onChange: () => update({ prOffers: !draft.prOffers }),
            })}
          </fieldset>
        )}
        {draft.paused ? null : (
          <fieldset className="forge-automation-dialog__group forge-automation-dialog__fieldset">
            <legend className="forge-automation-dialog__label">Merging</legend>
            {option({
              id: `${optionId}-never-merge`,
              type: "checkbox",
              title: "Never merge this project's pull requests",
              description: "For a fork that only sends changes upstream. No Merge cards or Merge buttons, and agents are told not to merge.",
              checked: draft.neverMerge === true,
              // Stored only when on, as the owner stores it.
              onChange: () => update({ neverMerge: draft.neverMerge ? undefined : true }),
            })}
            {draft.neverMerge ? (
              <div className="forge-automation-dialog__merge-branches">
                <p id={`${optionId}-branches-label`} className="forge-automation-dialog__sublabel">
                  Except pull requests into
                </p>
                {mergeBranches.length ? (
                  <ul aria-labelledby={`${optionId}-branches-label`} className="forge-automation-dialog__branch-list">
                    {mergeBranches.map((branch) => (
                      <li key={branch} className="forge-automation-dialog__branch">
                        <span className="forge-automation-dialog__branch-name">{branch}</span>
                        <button
                          aria-label={`Remove ${branch}`}
                          className="forge-automation-dialog__branch-remove tooltip-target"
                          data-tooltip={`Remove ${branch}`}
                          disabled={busy}
                          type="button"
                          onClick={() => removeBranch(branch)}
                        >
                          <CloseIcon size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {branchesFull ? null : (
                  <div className="forge-automation-dialog__branch-add">
                    <input
                      ref={branchInputRef}
                      aria-describedby={`${optionId}-branches-hint${branchError ? ` ${optionId}-branches-error` : ""}`}
                      aria-invalid={branchError ? true : undefined}
                      aria-label="Branch that still merges"
                      autoCapitalize="off"
                      autoComplete="off"
                      disabled={busy}
                      placeholder="Branch name"
                      spellCheck={false}
                      type="text"
                      value={branchInput}
                      onChange={(event) => {
                        setBranchInput(event.target.value);
                        setBranchError(undefined);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addBranch();
                      }}
                    />
                    <button
                      className="button button--secondary"
                      disabled={busy || !branchInput.trim()}
                      type="button"
                      onClick={addBranch}
                    >
                      Add
                    </button>
                  </div>
                )}
                {branchError ? (
                  <p id={`${optionId}-branches-error`} className="forge-automation-dialog__branch-error" role="alert">
                    {branchError}
                  </p>
                ) : null}
                <p id={`${optionId}-branches-hint`} className="forge-automation-dialog__hint">
                  An integration branch of your own. Pull requests into any other branch stay unmerged.
                </p>
              </div>
            ) : null}
          </fieldset>
        )}
        {draft.paused ? null : (
          <div className="forge-automation-dialog__group">
            <p aria-hidden="true" className="forge-automation-dialog__label">Merge build watches</p>
            <SegmentedControl<ProjectMergeBuildWatches>
              disabled={busy || !draft.prWatches}
              label="Merge build watches"
              options={[
                { label: "Default", value: "default" },
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
              value={draft.mergeBuildWatches ?? "default"}
              onChange={(value) => update({ mergeBuildWatches: value === "default" ? undefined : value })}
            />
            <p className="forge-automation-dialog__hint">
              {describeMergeBuildWatchChoice(draft)}
            </p>
          </div>
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
 * Hands-off pull requests: rules that leave a PR to its repository's
 * maintainers. Each row is a repository and, optionally, a label pattern;
 * the add row takes both and validates as the owner will.
 */
function HandsOffRules(props: {
  busy: boolean;
  rules: readonly ProjectForgeHandsOffRule[];
  suggestions: readonly string[];
  onChange: (rules: ProjectForgeHandsOffRule[]) => void;
}) {
  const id = useId();
  const [repository, setRepository] = useState("");
  const [label, setLabel] = useState("");
  const [addError, setAddError] = useState<string>();
  const repositoryRef = useRef<HTMLInputElement>(null);
  const full = props.rules.length >= MAX_HANDS_OFF_RULES;
  const picks = props.suggestions.filter((suggestion) =>
    suggestion.toLowerCase() !== repository.trim().toLowerCase());

  const add = () => {
    const normalized = normalizeHandsOffRepository(repository);
    if (!normalized) {
      setAddError("Enter the repository as owner/name.");
      repositoryRef.current?.focus();
      return;
    }
    const next = normalizeHandsOffRules([
      ...props.rules,
      { repository: normalized, ...(label.trim() ? { label: label.trim() } : {}) },
    ]);
    if (next.length === props.rules.length) {
      setAddError("That rule is already in the list.");
      return;
    }
    props.onChange(next);
    setRepository("");
    setLabel("");
    setAddError(undefined);
    repositoryRef.current?.focus();
  };

  return (
    <fieldset
      aria-describedby={`${id}-hint`}
      className="forge-automation-dialog__group forge-automation-dialog__fieldset"
    >
      <legend className="forge-automation-dialog__label">Hands-off pull requests</legend>
      <p id={`${id}-hint`} className="forge-automation-dialog__hint forge-automation-dialog__hint--lead">
        Leave a PR to its maintainers, such as an upstream PR they take over. Auto-fix skips it and no Review or Merge card is raised. <code>*</code> in a label matches any text.
      </p>
      {props.rules.length > 0 ? (
        <ul aria-label="Hands-off rules" className="forge-automation-dialog__rules">
          {props.rules.map((rule) => {
            const description = rule.label ? `labeled ${rule.label}` : "every PR";
            return (
              <li key={`${rule.repository}\n${rule.label ?? ""}`} className="forge-automation-dialog__rule">
                <span className="forge-automation-dialog__rule-repository">{rule.repository}</span>
                <span className="forge-automation-dialog__rule-condition">{description}</span>
                <button
                  aria-label={`Remove ${rule.repository}, ${description}`}
                  className="button button--ghost forge-automation-dialog__rule-remove"
                  disabled={props.busy}
                  type="button"
                  onClick={() => props.onChange(props.rules.filter((candidate) => candidate !== rule))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {full ? null : (
        <div className="forge-automation-dialog__rule-add">
          <label className="forge-automation-dialog__rule-field">
            <span>Repository</span>
            <input
              ref={repositoryRef}
              aria-describedby={addError ? `${id}-error` : undefined}
              aria-invalid={addError ? true : undefined}
              autoCapitalize="off"
              autoComplete="off"
              disabled={props.busy}
              maxLength={MAX_HANDS_OFF_RULE_TEXT}
              placeholder="owner/name"
              spellCheck={false}
              type="text"
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                setAddError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </label>
          <label className="forge-automation-dialog__rule-field">
            <span>Label</span>
            <input
              autoCapitalize="off"
              autoComplete="off"
              disabled={props.busy}
              maxLength={MAX_HANDS_OFF_RULE_TEXT}
              placeholder="Any PR"
              spellCheck={false}
              type="text"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setAddError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </label>
          <button
            className="button button--secondary forge-automation-dialog__rule-submit"
            disabled={props.busy || repository.trim().length === 0}
            type="button"
            onClick={add}
          >
            Add rule
          </button>
        </div>
      )}
      {!full && picks.length > 0 ? (
        <div className="forge-automation-dialog__rule-picks">
          <span id={`${id}-picks`}>Remotes</span>
          <div aria-labelledby={`${id}-picks`} role="group">
            {picks.map((suggestion) => (
              <button
                key={suggestion}
                className="forge-automation-dialog__rule-pick"
                disabled={props.busy}
                type="button"
                onClick={() => {
                  setRepository(suggestion);
                  setAddError(undefined);
                  repositoryRef.current?.focus();
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {addError ? (
        <p id={`${id}-error`} className="rename-thread-dialog__error" role="alert">{addError}</p>
      ) : null}
    </fieldset>
  );
}

/** What the merge build choice does, under its control. */
function describeMergeBuildWatchChoice(draft: ProjectForgeAutomation): string {
  if (!draft.prWatches) return "PR watches are off, so no merge build is watched.";
  switch (draft.mergeBuildWatches ?? "default") {
    case "on":
      return "After a PR merges, PwrAgent watches its build on the target branch and wakes the thread if it fails.";
    case "off":
      return "No merge build is watched unless a thread asks for it.";
    default:
      return "Follows Watch merge builds in Git settings.";
  }
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
