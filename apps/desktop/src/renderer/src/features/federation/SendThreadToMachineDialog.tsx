import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ThreadGitWorkingState } from "@pwragent/shared";
import { CelestialIcon, MinimizeIcon } from "../../icons";
import { flyBetween } from "../../lib/fly-between";
import type { ProjectIdentity } from "../../lib/federation-project-match";
import { useModalDialog } from "../../lib/useModalDialog";
import { InstanceGlyph } from "./InstanceGlyph";
import { threadHandoffCancelBlockedReason, threadHandoffVerb } from "./thread-handoff-copy";
import type {
  ThreadHandoffChoice,
  ThreadHandoffOperation,
  ThreadHandoffTransfer,
} from "./thread-handoff-transfer";
import { ThreadHandoffSteps } from "./ThreadHandoffProgress";
import {
  describeThreadHandoffTargetAvailability,
  THREAD_HANDOFF_TARGET_STATE_LABEL,
  type ThreadHandoffTarget,
} from "./thread-handoff-targets";

export type { ThreadHandoffOperation } from "./thread-handoff-transfer";

/** The receiver's checkout for this thread's project, as its index reports it. */
export type ThreadHandoffRepositoryMatch = {
  path: string;
  /** Which rule found it: origin, another configured remote, or project name. */
  matchedBy: "origin" | "remote" | "name";
};

export type FindThreadHandoffRepository = (
  instanceId: string,
  project: ProjectIdentity,
) => Promise<ThreadHandoffRepositoryMatch | undefined>;

export type SendThreadToMachineRequest = ThreadHandoffChoice;

export type SendThreadToMachineSource = {
  title: string;
  /** The thread's Git project. Non-Git workspaces travel as an archive. */
  project?: ProjectIdentity;
  gitBranch?: string;
  gitWorkingState?: ThreadGitWorkingState;
  /**
   * A turn is running. The backend refuses to reserve a busy thread, so Send
   * waits; the dialog stays open and enables it when the turn ends.
   */
  busy?: boolean;
};

type RepositoryLookup =
  | { state: "checking" }
  | { state: "found"; match: ThreadHandoffRepositoryMatch }
  | { state: "missing" };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What the transfer carries, from the row's last Git probe. No Git read runs
 * before the operator confirms; the backend captures the real state.
 */
function describeSent(source: SendThreadToMachineSource): string {
  const parts = ["History"];
  const state = source.gitWorkingState;
  if (state) {
    if (state.unpushedCommits > 0) {
      parts.push(plural(state.unpushedCommits, "unpushed commit", "unpushed commits"));
    }
    if (state.dirtyFiles > 0) {
      parts.push(plural(state.dirtyFiles, "changed file", "changed files"));
    }
    if (state.untrackedFiles > 0) {
      parts.push(plural(state.untrackedFiles, "untracked file", "untracked files"));
    }
  } else {
    parts.push("commits the receiver lacks, staged, unstaged and untracked files");
  }
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : `${parts[0]} and the current commit`;
  return source.gitBranch ? `${list} on ${source.gitBranch}` : list;
}

function TargetMark(props: { target: ThreadHandoffTarget }) {
  return props.target.celestialIcon ? (
    <CelestialIcon icon={props.target.celestialIcon} size={13} />
  ) : (
    <InstanceGlyph instanceId={props.target.instanceId} size={13} />
  );
}

/**
 * Copy or move a thread this machine owns to another PwrAgent, with its
 * history and Git working state. The desktop face of the
 * `handoff_instance_thread` agent tool: the same backend call, with the
 * machine, repository and operation picked from what this window already
 * knows instead of instance ids and native paths typed into a prompt.
 *
 * The transfer itself lives above the dialog, in the window. While it runs,
 * the dialog lists its steps, and Minimise, Escape and a click outside all
 * send it to the toast stack instead of closing: closing would hide a
 * transfer that is still holding the thread. Once it settles, a failure or a
 * cancel comes back here with the operator's choices kept for a retry.
 */
export function SendThreadToMachineDialog(props: {
  source: SendThreadToMachineSource;
  targets: readonly ThreadHandoffTarget[];
  findRepository?: FindThreadHandoffRepository;
  /** This thread's latest handoff from this window, running or settled. */
  transfer?: ThreadHandoffTransfer;
  /** Choices to start from, as when Retry reopens a failed send. */
  initialChoice?: ThreadHandoffChoice;
  /** The rect to fly in from, when the dialog reopens from a toast. */
  flyFrom?: DOMRect;
  onSend: (request: SendThreadToMachineRequest) => void;
  /** Sends a running transfer to the toast stack, from this rect. */
  onMinimise?: (from: DOMRect | undefined) => void;
  onCancelTransfer?: () => void;
  onRetryNow?: () => void;
  onClose: () => void;
}) {
  const { source, targets, findRepository, transfer } = props;
  const project = source.project;
  const startChoice = transfer?.choice ?? props.initialChoice;
  const [targetId, setTargetId] = useState<string | undefined>(
    () => startChoice?.targetInstanceId
      ?? targets.find((target) => target.availability === "available")?.instanceId,
  );
  const [operation, setOperation] = useState<ThreadHandoffOperation>(
    () => startChoice?.operation ?? "copy",
  );
  const [lookups, setLookups] = useState<Record<string, RepositoryLookup>>({});
  // Paths the operator typed, per machine, so a late lookup never overwrites one.
  const [typedPaths, setTypedPaths] = useState<Record<string, string>>(() =>
    startChoice?.targetRepositoryPath
      ? { [startChoice.targetInstanceId]: startChoice.targetRepositoryPath }
      : {});
  const sending = transfer?.status === "running";
  const error = transfer?.status === "failed" ? transfer.error : undefined;

  const availableIds = useMemo(
    () => targets
      .filter((target) => target.availability === "available")
      .map((target) => target.instanceId)
      .join("\n"),
    [targets],
  );
  const projectKind = project?.kind;
  const projectLabel = project?.label;
  const projectPath = project?.path;
  const projectRepositoryKey = project?.repositoryKey;
  const projectRepositoryKeys = project?.repositoryKeys?.join("\n");
  useEffect(() => {
    if (!findRepository || !projectKind || projectLabel === undefined || !availableIds) {
      return;
    }
    const lookupProject: ProjectIdentity = {
      kind: projectKind,
      label: projectLabel,
      ...(projectPath !== undefined ? { path: projectPath } : {}),
      ...(projectRepositoryKey !== undefined ? { repositoryKey: projectRepositoryKey } : {}),
      ...(projectRepositoryKeys !== undefined ? { repositoryKeys: projectRepositoryKeys.split("\n") } : {}),
    };
    const ids = availableIds.split("\n");
    let cancelled = false;
    setLookups(Object.fromEntries(ids.map((id) => [id, { state: "checking" } as const])));
    for (const id of ids) {
      void findRepository(id, lookupProject)
        .then((match): RepositoryLookup =>
          match ? { state: "found", match } : { state: "missing" })
        .catch((): RepositoryLookup => ({ state: "missing" }))
        .then((lookup) => {
          if (!cancelled) setLookups((current) => ({ ...current, [id]: lookup }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [availableIds, findRepository, projectKind, projectLabel, projectPath, projectRepositoryKey, projectRepositoryKeys]);

  const minimise = (): void => {
    props.onMinimise?.(dialogRef.current?.getBoundingClientRect());
  };
  const dialogRef = useModalDialog({
    onClose: () => {
      if (sending) minimise();
      else props.onClose();
    },
  });
  const flyFrom = props.flyFrom;
  useLayoutEffect(() => {
    if (flyFrom && dialogRef.current) flyBetween(flyFrom, dialogRef.current);
  }, [dialogRef, flyFrom]);
  // Starting or settling a send swaps the dialog's contents, and the control
  // that held focus goes with them. Keep focus inside, on the dialog itself.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [dialogRef, sending]);

  const target = targets.find((candidate) => candidate.instanceId === targetId);
  const lookup = targetId ? lookups[targetId] : undefined;
  const repositoryPath = targetId === undefined
    ? ""
    : typedPaths[targetId]
      ?? (lookup?.state === "found" ? lookup.match.path : "");
  const verb = operation === "copy" ? "Copy" : "Move";
  const canSend =
    !sending
    && !source.busy
    && target?.availability === "available"
    && (!project || repositoryPath.trim().length > 0);

  const send = (): void => {
    if (!canSend || !targetId) return;
    props.onSend({
      targetInstanceId: targetId,
      operation,
      ...(project ? { targetRepositoryPath: repositoryPath.trim() } : {}),
    });
  };

  const describeRow = (candidate: ThreadHandoffTarget): string | undefined => {
    if (candidate.availability !== "available") {
      return THREAD_HANDOFF_TARGET_STATE_LABEL[candidate.availability];
    }
    if (!project) return undefined;
    const rowLookup = lookups[candidate.instanceId];
    if (rowLookup?.state === "checking") return "Checking…";
    if (rowLookup?.state === "missing") return "No matching project";
    return rowLookup?.state === "found" ? project.label : undefined;
  };

  const repositoryHint = !target || target.availability !== "available"
    ? undefined
    : lookup?.state === "checking"
      ? `Looking for ${project?.label ?? "this project"} on ${target.label}…`
      : lookup?.state === "found"
        ? `${lookup.match.matchedBy === "origin" && project?.repositoryKey
          ? `Matched by origin ${project.repositoryKey}.`
          : lookup.match.matchedBy === "remote"
            ? "Matched by a configured Git remote."
            : "Matched by project name. Check that it is a clone of the same repository."
        } A new worktree uses the source branch when available, or starts detached at the source commit.`
        : `${target.label} has no project ${
          project?.repositoryKey ? "with this origin" : `named ${project?.label ?? "like this one"}`
        }. Enter the path of a clone there that shares this repository's history.`;

  if (sending && transfer) {
    const noun = transfer.choice.operation === "move" ? "Move" : "Copy";
    const blocked = threadHandoffCancelBlockedReason(transfer);
    return createPortal(
      <div
        className="workspace-handoff-modal"
        onMouseDown={(event) => {
          // A click on the scrim minimises; the dialog keeps its own clicks.
          if (event.target === event.currentTarget) minimise();
        }}
      >
        <div
          ref={dialogRef}
          aria-label="Send to Another Machine"
          aria-modal="true"
          aria-busy="true"
          className="workspace-handoff-dialog thread-handoff-dialog"
          role="dialog"
          tabIndex={-1}
        >
          <div className="thread-handoff-dialog__head">
            <h2>{threadHandoffVerb(transfer)} to {transfer.targetLabel}</h2>
            <button
              aria-label="Minimise"
              className="thread-handoff-dialog__minimise tooltip-target"
              data-tooltip={`Keep working. The ${noun.toLowerCase()} continues in a toast.`}
              type="button"
              onClick={minimise}
            >
              <MinimizeIcon size={14} />
            </button>
          </div>
          <p>
            &ldquo;{source.title}&rdquo; continues there with its history
            {project ? " and published commit" : ""}. This thread takes no new turns
            until the {noun.toLowerCase()} finishes.
          </p>
          <div role="status" aria-live="polite">
            <ThreadHandoffSteps transfer={transfer} />
          </div>
          {transfer.link === "waiting" ? (
            <p className="workspace-handoff-dialog__note">
              The connection to {transfer.targetLabel} dropped. The {noun.toLowerCase()}{" "}
              continues when it reconnects, and nothing it already has is sent again.
            </p>
          ) : null}
          <div className="workspace-handoff-dialog__actions thread-handoff-dialog__actions">
            <button className="button button--ghost" type="button" onClick={minimise}>
              Run in Background
            </button>
            {transfer.link === "waiting" ? (
              <button className="button button--ghost" type="button" onClick={props.onRetryNow}>
                Retry Now
              </button>
            ) : null}
            <button
              className={`button button--ghost${blocked ? " tooltip-target" : ""}`}
              data-tooltip={blocked}
              disabled={!transfer.cancelable || transfer.cancelRequested}
              type="button"
              onClick={props.onCancelTransfer}
            >
              {transfer.cancelRequested ? "Cancelling…" : `Cancel ${noun}`}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="workspace-handoff-modal">
      <div
        ref={dialogRef}
        aria-label="Send to Another Machine"
        aria-modal="true"
        className="workspace-handoff-dialog thread-handoff-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <h2>Send to Another Machine</h2>
        <p>
          Continue &ldquo;{source.title}&rdquo; on another PwrAgent with its history
          {project ? " and published commit" : ""}.
        </p>
        <div className="workspace-handoff-dialog__field">
          <span id="thread-handoff-machine-label">Machine</span>
          <div
            aria-labelledby="thread-handoff-machine-label"
            className="thread-handoff-dialog__machines"
            role="radiogroup"
          >
            {targets.map((candidate) => {
              const state = describeRow(candidate);
              const unavailable = candidate.availability !== "available";
              return (
                <button
                  key={candidate.instanceId}
                  aria-checked={candidate.instanceId === targetId}
                  className="thread-handoff-dialog__machine"
                  disabled={unavailable}
                  role="radio"
                  title={[candidate.shortLabel ? candidate.label : undefined,
                    describeThreadHandoffTargetAvailability(candidate)].filter(Boolean).join(" · ") || undefined}
                  type="button"
                  onClick={() => setTargetId(candidate.instanceId)}
                >
                  <span aria-hidden="true" className="thread-handoff-dialog__machine-mark">
                    <TargetMark target={candidate} />
                  </span>
                  <span className="thread-handoff-dialog__machine-label">
                    {candidate.shortLabel ?? candidate.label}
                  </span>
                  {state ? (
                    <span className="thread-handoff-dialog__machine-state">{state}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        {project && target ? (
          <div className="workspace-handoff-dialog__field">
            <label htmlFor="thread-handoff-repository">
              Repository on {target.label}
            </label>
            <input
              aria-describedby={repositoryHint ? "thread-handoff-repository-hint" : undefined}
              className="workspace-handoff-dialog__text-input thread-handoff-dialog__path"
              disabled={target.availability !== "available"}
              id="thread-handoff-repository"
              placeholder={`Absolute path to an existing clone on ${target.label}`}
              spellCheck={false}
              type="text"
              value={repositoryPath}
              onChange={(event) => {
                const value = event.target.value;
                setTypedPaths((current) => ({ ...current, [target.instanceId]: value }));
              }}
            />
            {repositoryHint ? (
              <span
                className="thread-handoff-dialog__hint"
                id="thread-handoff-repository-hint"
              >
                {repositoryHint}
              </span>
            ) : null}
          </div>
        ) : null}
        {!project ? (
          <p className="workspace-handoff-dialog__note">
            This thread has no Git project. Its history starts in a new workspace
            {target ? ` on ${target.label}` : ""}. Any available workspace is also
            copied, including hidden files. Remove sensitive files before sending.
            Symlinks pointing outside the workspace are omitted; all symlinks are
            omitted when Windows is involved.
          </p>
        ) : null}
        <div
          aria-label="Copy or move"
          className="workspace-handoff-dialog__strategy-list thread-handoff-dialog__operations"
          role="radiogroup"
        >
          <button
            aria-checked={operation === "copy"}
            className="workspace-handoff-dialog__strategy"
            role="radio"
            type="button"
            onClick={() => setOperation("copy")}
          >
            <span className="workspace-handoff-dialog__strategy-title">Copy</span>
            <span>
              Keep this thread. A new thread continues on {target?.label ?? "the other machine"}.
            </span>
          </button>
          <button
            aria-checked={operation === "move"}
            className="workspace-handoff-dialog__strategy"
            role="radio"
            type="button"
            onClick={() => setOperation("move")}
          >
            <span className="workspace-handoff-dialog__strategy-title">Move</span>
            <span>
              Archive this thread after the copy is verified.
              {project ? " Its worktree stays on disk." : ""}
            </span>
          </button>
        </div>
        {project ? (
          <dl className="thread-handoff-dialog__carry">
            <div>
              <dt>Sent</dt>
              <dd>{describeSent(source)}</dd>
            </div>
            <div>
              <dt>Stays here</dt>
              <dd>Pull request link, schedules, messaging bindings, ignored files</dd>
            </div>
          </dl>
        ) : null}
        {transfer?.status === "cancelled" ? (
          <p className="workspace-handoff-dialog__note" role="status">
            {transfer.choice.operation === "move" ? "Move" : "Copy"} cancelled. Nothing
            was created on {transfer.targetLabel}.
          </p>
        ) : null}
        {source.busy ? (
          <p className="workspace-handoff-dialog__note" role="status">
            This thread is running. Sending becomes available when the current turn
            finishes.
          </p>
        ) : null}
        {error ? (
          <p className="workspace-handoff-dialog__error" role="alert">{error}</p>
        ) : null}
        <div className="workspace-handoff-dialog__actions">
          <button
            className="button button--ghost"
            type="button"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={!canSend}
            type="button"
            onClick={send}
          >
            {target ? `${verb} to ${target.label}` : verb}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
