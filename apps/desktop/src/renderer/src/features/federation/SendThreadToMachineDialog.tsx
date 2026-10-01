import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ThreadGitWorkingState } from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import type { ProjectIdentity } from "../../lib/federation-project-match";
import { useModalDialog } from "../../lib/useModalDialog";
import { InstanceGlyph } from "./InstanceGlyph";
import {
  describeThreadHandoffTargetAvailability,
  THREAD_HANDOFF_TARGET_STATE_LABEL,
  type ThreadHandoffTarget,
} from "./thread-handoff-targets";

export type ThreadHandoffOperation = "copy" | "move";

/** The receiver's checkout for this thread's project, as its index reports it. */
export type ThreadHandoffRepositoryMatch = {
  path: string;
  /** Which rule found it: the checkout's origin, or only the project name. */
  matchedBy: "origin" | "name";
};

export type FindThreadHandoffRepository = (
  instanceId: string,
  project: ProjectIdentity,
) => Promise<ThreadHandoffRepositoryMatch | undefined>;

export type SendThreadToMachineRequest = {
  targetInstanceId: string;
  operation: ThreadHandoffOperation;
  targetRepositoryPath?: string;
};

export type SendThreadToMachineSource = {
  title: string;
  /** The thread's Git project. Absent for a Workspaces thread: history only. */
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
 * The request has no progress events and cannot be aborted once the package
 * is pushed, so the dialog holds one pending state and refuses to close until
 * the call returns. A dialog closed mid-transfer would report nothing.
 */
export function SendThreadToMachineDialog(props: {
  source: SendThreadToMachineSource;
  targets: readonly ThreadHandoffTarget[];
  findRepository?: FindThreadHandoffRepository;
  onSend: (request: SendThreadToMachineRequest) => Promise<void>;
  onClose: () => void;
}) {
  const { source, targets, findRepository } = props;
  const project = source.project;
  const [targetId, setTargetId] = useState<string | undefined>(
    () => targets.find((target) => target.availability === "available")?.instanceId,
  );
  const [operation, setOperation] = useState<ThreadHandoffOperation>("copy");
  const [lookups, setLookups] = useState<Record<string, RepositoryLookup>>({});
  // Paths the operator typed, per machine, so a late lookup never overwrites one.
  const [typedPaths, setTypedPaths] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

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
  useEffect(() => {
    if (!findRepository || !projectKind || projectLabel === undefined || !availableIds) {
      return;
    }
    const lookupProject: ProjectIdentity = {
      kind: projectKind,
      label: projectLabel,
      ...(projectPath !== undefined ? { path: projectPath } : {}),
      ...(projectRepositoryKey !== undefined ? { repositoryKey: projectRepositoryKey } : {}),
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
  }, [availableIds, findRepository, projectKind, projectLabel, projectPath, projectRepositoryKey]);

  const dialogRef = useModalDialog({
    onClose: () => {
      if (!sending) props.onClose();
    },
  });

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

  const send = async (): Promise<void> => {
    if (!canSend || !targetId) return;
    setSending(true);
    setError(undefined);
    try {
      await props.onSend({
        targetInstanceId: targetId,
        operation,
        ...(project ? { targetRepositoryPath: repositoryPath.trim() } : {}),
      });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      setSending(false);
    }
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
          : "Matched by project name. Check that it is a clone of the same repository."
        } The thread starts in a new detached worktree there.`
        : `${target.label} has no project ${
          project?.repositoryKey ? "with this origin" : `named ${project?.label ?? "like this one"}`
        }. Enter the path of a clone there that shares this repository's history.`;

  return createPortal(
    <div className="workspace-handoff-modal">
      <div
        ref={dialogRef}
        aria-label="Send to Another Machine"
        aria-modal="true"
        aria-busy={sending || undefined}
        className="workspace-handoff-dialog thread-handoff-dialog"
        role="dialog"
      >
        <h2>Send to Another Machine</h2>
        <p>
          Continue &ldquo;{source.title}&rdquo; on another PwrAgent with its history
          {project ? " and uncommitted work" : ""}.
        </p>
        {sending ? (
          <p className="workspace-handoff-dialog__note" role="status">
            Sending to {target?.label}. This thread cannot take new turns until the
            transfer finishes. Large workspaces can take a few minutes.
          </p>
        ) : (
          <>
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
                      title={describeThreadHandoffTargetAvailability(candidate)}
                      type="button"
                      onClick={() => {
                        setTargetId(candidate.instanceId);
                        setError(undefined);
                      }}
                    >
                      <span aria-hidden="true" className="thread-handoff-dialog__machine-mark">
                        <TargetMark target={candidate} />
                      </span>
                      <span className="thread-handoff-dialog__machine-label">
                        {candidate.label}
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
                {target ? ` on ${target.label}` : ""}. Files in this workspace are not
                copied.
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
          </>
        )}
        {source.busy && !sending ? (
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
            disabled={sending}
            type="button"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={!canSend}
            type="button"
            onClick={() => {
              void send();
            }}
          >
            {sending
              ? `${operation === "copy" ? "Copying" : "Moving"}…`
              : target
                ? `${verb} to ${target.label}`
                : verb}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
