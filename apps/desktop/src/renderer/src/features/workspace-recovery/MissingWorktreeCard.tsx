import { useId, useState, type ReactNode } from "react";
import type {
  MoveThreadToMainCheckoutResponse,
  RecreateThreadWorktreeResponse,
  ThreadMissingWorkspace,
  WorktreeRecoveryStep,
  WorktreeRecoveryStepId,
} from "@pwragent/shared";
import { CheckIcon, CloseIcon, WorktreeIcon } from "../../icons";

type RecreatedResponse = Extract<RecreateThreadWorktreeResponse, { status: "recreated" }>;
type RefusedResponse = Extract<RecreateThreadWorktreeResponse, { status: "failed" }>;
type RecreateOptions = { skipCheckpoint?: boolean; detached?: boolean };

export type WorkspaceRecoveryOutcome =
  | { kind: "recreated"; response: RecreatedResponse; checkpointArchivedAt?: number }
  | { kind: "moved"; response: MoveThreadToMainCheckoutResponse; previousBranch?: string };

export type MissingWorktreeCardProps = {
  missing: ThreadMissingWorkspace;
  /** The machine that owns the thread, when it is not this one. */
  ownerLabel?: string;
  ownerOffline?: boolean;
  turnActive?: boolean;
  onRecreate?: (options: RecreateOptions) => Promise<RecreateThreadWorktreeResponse>;
  onMoveToMainCheckout?: () => Promise<MoveThreadToMainCheckoutResponse>;
  onArchive?: () => Promise<unknown>;
  onRecovered: (outcome: WorkspaceRecoveryOutcome) => void;
};

type CardState =
  | { phase: "idle" }
  | { phase: "running"; action: "recreate" | "move" | "archive"; options: RecreateOptions }
  | { phase: "refused"; response: RefusedResponse; options: RecreateOptions }
  | { phase: "error"; action: "recreate" | "move" | "archive"; options: RecreateOptions; message: string; outdated: boolean };

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function formatCheckpointDay(archivedAt: number | undefined): string | undefined {
  return archivedAt === undefined ? undefined : DAY_FORMAT.format(archivedAt);
}

/** `method_not_found` does not survive the IPC hop as a code; match the text. */
export function isOutdatedOwnerError(message: string): boolean {
  return /\bmethod_not_found\b/.test(message) || message.includes("No federation handler registered");
}

function stepLabel(id: WorktreeRecoveryStepId, missing: ThreadMissingWorkspace, options: RecreateOptions): ReactNode {
  const day = formatCheckpointDay(missing.checkpoint?.archivedAt);
  switch (id) {
    case "check-path":
      return "Check the folder is free";
    case "find-checkpoint":
      return missing.checkpoint ? `Find the ${day ? `${day} ` : ""}checkpoint` : "Look for a checkpoint";
    case "clear-record":
      return "Clear Git’s record of the deleted folder";
    case "add-worktree":
      return missing.branch && !options.detached
        ? <>Add the worktree on <code>{missing.branch}</code></>
        : "Add the worktree on a detached HEAD";
    case "apply-checkpoint":
      return "Restore the checkpoint’s uncommitted changes";
  }
}

function plannedSteps(missing: ThreadMissingWorkspace, options: RecreateOptions): WorktreeRecoveryStepId[] {
  return [
    "check-path",
    "find-checkpoint",
    "clear-record",
    "add-worktree",
    ...(missing.checkpoint && !options.skipCheckpoint ? ["apply-checkpoint" as const] : []),
  ];
}

function StepList(props: {
  steps: Array<{ id: WorktreeRecoveryStepId; status: WorktreeRecoveryStep["status"] | "planned"; detail?: string }>;
  missing: ThreadMissingWorkspace;
  options: RecreateOptions;
}) {
  return (
    <ul className="missing-worktree-card__steps" aria-label="Steps">
      {props.steps.map((step) => (
        <li key={step.id} className={`missing-worktree-card__step is-${step.status}`}>
          <span className="missing-worktree-card__step-mark" aria-hidden="true">
            {step.status === "done" ? <CheckIcon size={13} />
              : step.status === "failed" ? <CloseIcon size={13} />
              : step.status === "skipped" ? <span className="missing-worktree-card__dash" />
              : <span className="missing-worktree-card__ring" />}
          </span>
          <span>
            <span className="missing-worktree-card__sr">
              {step.status === "done" ? "Done: " : step.status === "failed" ? "Failed: " : step.status === "skipped" ? "Skipped: " : "To do: "}
            </span>
            {stepLabel(step.id, props.missing, props.options)}
            {step.status === "failed" && step.detail ? (
              <small className="missing-worktree-card__step-detail">{step.detail}</small>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Takes the composer's place when a thread's worktree folder is gone, and
 * offers the three ways on: put the worktree back, work in the main checkout,
 * or archive the thread. Every action runs on the thread's owner.
 */
export function MissingWorktreeCard(props: MissingWorktreeCardProps) {
  const headingId = useId();
  const [state, setState] = useState<CardState>({ phase: "idle" });
  const { missing } = props;
  const owner = props.ownerLabel;
  const day = formatCheckpointDay(missing.checkpoint?.archivedAt);
  const busy = state.phase === "running";
  const blocked = busy || props.ownerOffline === true || props.turnActive === true;
  const canRecreate = Boolean(props.onRecreate) && missing.repositoryAvailable;
  const canMove = Boolean(props.onMoveToMainCheckout) && missing.repositoryAvailable;

  const run = async (action: "recreate" | "move" | "archive", options: RecreateOptions = {}) => {
    setState({ phase: "running", action, options });
    try {
      if (action === "recreate") {
        const response = await props.onRecreate!(options);
        if (response.status === "failed") {
          setState({ phase: "refused", response, options });
          return;
        }
        setState({ phase: "idle" });
        props.onRecovered({ kind: "recreated", response, checkpointArchivedAt: missing.checkpoint?.archivedAt });
      } else if (action === "move") {
        const response = await props.onMoveToMainCheckout!();
        setState({ phase: "idle" });
        props.onRecovered({ kind: "moved", response, previousBranch: missing.branch });
      } else {
        await props.onArchive!();
        setState({ phase: "idle" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ phase: "error", action, options, message, outdated: isOutdatedOwnerError(message) });
    }
  };

  const button = (label: string, onClick: () => void, kind: "primary" | "secondary" | "ghost", enabled = true) => (
    <button
      className={`button button--${kind}`}
      disabled={blocked || !enabled}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
  const recreate = (options: RecreateOptions = {}) => () => void run("recreate", options);
  const move = () => void run("move");
  const archive = () => void run("archive");

  const heading = state.phase === "running"
    ? state.action === "recreate" ? "Recreating worktree…"
      : state.action === "move" ? "Moving to the main checkout…"
      : "Archiving thread…"
    : "This thread’s worktree is gone";

  let body: ReactNode;
  if (state.phase === "running" && state.action === "recreate") {
    body = (
      <StepList
        missing={missing}
        options={state.options}
        steps={plannedSteps(missing, state.options).map((id) => ({ id, status: "planned" as const }))}
      />
    );
  } else if (state.phase === "refused") {
    const { response, options } = state;
    const retry = recreate(options);
    const actions: ReactNode = (() => {
      switch (response.reason) {
        case "record-locked":
          return <>{button("Try Again", retry, "primary")}{button("Continue in Main Checkout", move, "secondary", canMove)}{props.onArchive ? button("Archive", archive, "ghost") : null}</>;
        case "branch-checked-out":
        case "branch-missing":
          return <>{button("Recreate Detached", recreate({ ...options, detached: true }), "primary")}{button("Try Again", retry, "secondary")}{button("Continue in Main Checkout", move, "ghost", canMove)}</>;
        case "checkpoint-missing":
          return <>{button("Recreate Without Checkpoint", recreate({ ...options, skipCheckpoint: true }), "primary")}{button("Continue in Main Checkout", move, "secondary", canMove)}{props.onArchive ? button("Archive", archive, "ghost") : null}</>;
        case "path-occupied":
          return <>{button("Try Again", retry, "secondary")}{button("Continue in Main Checkout", move, "primary", canMove)}{props.onArchive ? button("Archive", archive, "ghost") : null}</>;
        case "repository-missing":
          return props.onArchive ? button("Archive", archive, "primary") : null;
      }
    })();
    body = (
      <>
        <StepList
          missing={missing}
          options={options}
          steps={response.steps.map((step) => (step.detail === response.message ? { ...step, detail: undefined } : step))}
        />
        <p className="missing-worktree-card__error" role="alert">{response.message}</p>
        <div className="missing-worktree-card__actions">{actions}</div>
      </>
    );
  } else if (state.phase === "error") {
    const machine = owner ?? "the other machine";
    body = (
      <>
        <p className="missing-worktree-card__error" role="alert">
          {state.outdated
            ? `${machine} runs an older PwrAgent. Update PwrAgent on ${machine} to recreate or move this worktree. Archive still works.`
            : state.message}
        </p>
        <div className="missing-worktree-card__actions">
          {state.outdated && props.onArchive ? button("Archive", archive, "primary") : null}
          {button("Try Again", state.action === "recreate" ? recreate(state.options) : state.action === "move" ? move : archive, state.outdated ? "secondary" : "primary")}
          {!state.outdated ? button("Back", () => setState({ phase: "idle" }), "ghost") : null}
        </div>
      </>
    );
  } else {
    const recreateDescription: ReactNode = !missing.repositoryAvailable
      ? <>Needs the main checkout at <code>{missing.repositoryPath}</code>, which is gone too.</>
      : missing.branch
        ? missing.checkpoint
          ? <>Same folder, back on <code>{missing.branch}</code>, with the uncommitted changes saved{day ? ` on ${day}` : ""}.</>
          : <>Same folder, back on <code>{missing.branch}</code>. No checkpoint was recorded, so uncommitted changes from before the deletion may be gone.</>
        : "Same folder, on a detached HEAD.";
    const moveDescription: ReactNode = !missing.repositoryAvailable
      ? <><code>{missing.repositoryPath}</code> is gone too.</>
      : <>Work in <code>{missing.repositoryPath}</code> from now on. It stays on {missing.mainCheckoutBranch ? <code>{missing.mainCheckoutBranch}</code> : "its current branch"}; nothing is switched or stashed.</>;
    body = (
      <>
        <p className="missing-worktree-card__lede">
          {!missing.repositoryAvailable
            ? "The folder no longer exists, and neither does the main checkout it belonged to."
            : missing.checkpoint
              ? `PwrAgent archived this worktree${day ? ` on ${day}` : ""} and kept a checkpoint.`
              : "The folder no longer exists."}{" "}
          Choose where this thread works next; the composer comes back once it has a folder.
        </p>
        <div className="missing-worktree-card__options">
          <div className={`missing-worktree-card__option${canRecreate ? "" : " is-unavailable"}`}>
            <p className="missing-worktree-card__option-title">Recreate worktree</p>
            <p className="missing-worktree-card__option-text">{recreateDescription}</p>
            {button("Recreate", recreate(), "primary", canRecreate)}
          </div>
          <div className={`missing-worktree-card__option${canMove ? "" : " is-unavailable"}`}>
            <p className="missing-worktree-card__option-title">Continue in the main checkout</p>
            <p className="missing-worktree-card__option-text">{moveDescription}</p>
            {button("Continue", move, "secondary", canMove)}
          </div>
          <div className={`missing-worktree-card__option${props.onArchive ? "" : " is-unavailable"}`}>
            <p className="missing-worktree-card__option-title">Archive thread</p>
            <p className="missing-worktree-card__option-text">Remove the thread from your lists.</p>
            {button("Archive", archive, "secondary", Boolean(props.onArchive))}
          </div>
        </div>
        {props.ownerOffline || props.turnActive ? (
          <p className="missing-worktree-card__meta">
            {props.ownerOffline
              ? `${owner ?? "The owning machine"} is offline. These run on ${owner ?? "it"}, so they wait until it is back.`
              : "Available when the current turn ends."}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby={headingId}
      className={`missing-worktree-card${busy ? " missing-worktree-card--busy" : ""}`}
    >
      <h2 id={headingId} className="missing-worktree-card__heading">
        <WorktreeIcon size={15} aria-hidden="true" />
        {heading}
        {owner ? <span className="missing-worktree-card__owner">On {owner}</span> : null}
      </h2>
      <p className="missing-worktree-card__path">{missing.worktreePath}</p>
      {body}
      {state.phase === "running" && state.action !== "recreate" ? (
        <p className="missing-worktree-card__meta">Working…</p>
      ) : null}
    </section>
  );
}

/** What happened, kept above the composer until dismissed. */
export function WorkspaceRecoveryNotice(props: { outcome: WorkspaceRecoveryOutcome; onDismiss: () => void }) {
  const { outcome } = props;
  let title: ReactNode;
  let lines: ReactNode[];
  let warning = false;
  if (outcome.kind === "recreated") {
    const { response } = outcome;
    const day = formatCheckpointDay(outcome.checkpointArchivedAt);
    const where = response.branch ? <>on <code>{response.branch}</code></> : "on a detached HEAD";
    if (response.checkpoint && !response.checkpoint.restored) {
      warning = true;
      title = <><span className="workspace-recovery-notice__title">Worktree recreated without its checkpoint.</span> It is back {where}, but the checkpoint conflicts with newer commits, so nothing was applied.</>;
    } else if (response.checkpoint) {
      const count = response.checkpoint.changedFileCount;
      title = <><span className="workspace-recovery-notice__title">Worktree recreated</span> {where}. The {day ? `${day} ` : ""}checkpoint is back{count ? ` as ${count} uncommitted ${count === 1 ? "file" : "files"}` : ""}.</>;
    } else {
      title = <><span className="workspace-recovery-notice__title">Worktree recreated</span> {where}.</>;
    }
    lines = response.warnings.map((text) => text);
    if (response.steps.some((step) => step.id === "clear-record" && step.status === "done")) {
      lines.push("Cleared Git’s stale record of the folder first.");
    }
  } else {
    const { response } = outcome;
    title = <><span className="workspace-recovery-notice__title">Moved to the main checkout.</span> <code>{response.repositoryPath}</code> is still on {response.branch ? <code>{response.branch}</code> : "its branch"}.{outcome.previousBranch ? <> <code>{outcome.previousBranch}</code> was not touched.</> : null}</>;
    lines = response.warnings;
  }
  return (
    <div className={`workspace-recovery-notice${warning ? " workspace-recovery-notice--warning" : ""}`} role="status">
      <span className="workspace-recovery-notice__mark" aria-hidden="true">
        {warning ? "!" : <CheckIcon size={13} />}
      </span>
      <p>{title}</p>
      <button aria-label="Dismiss" className="workspace-recovery-notice__dismiss" type="button" onClick={props.onDismiss}>
        <CloseIcon size={13} aria-hidden="true" />
      </button>
      {lines.map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}
