import { useId, useState, type ReactNode } from "react";
import type { SetThreadCheckoutHibernationResponse, ThreadHibernatedWorkspace } from "@pwragent/shared";
import { CheckIcon, MoonIcon } from "../../icons";
import { formatAge, formatBytes } from "../maintenance/thread-maintenance-selection";

export type HibernatedCheckoutCardProps = {
  workspace: ThreadHibernatedWorkspace;
  /** The machine that owns the thread, when it is not this one. */
  ownerLabel?: string;
  ownerOffline?: boolean;
  onRestore?: () => Promise<SetThreadCheckoutHibernationResponse>;
  onKeepAwake?: () => Promise<SetThreadCheckoutHibernationResponse>;
};

type CardState =
  | { phase: "idle" }
  | { phase: "running"; action: "restore" | "keepAwake" }
  | { phase: "error"; message: string };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "node_modules and dist removed". Folder names only, each once. */
export function removedOutputText(removedOutput: readonly string[] | undefined): string | undefined {
  const names = [...new Set((removedOutput ?? []).map((folder) => folder.split("/").pop() ?? folder))];
  if (!names.length) return undefined;
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} removed`;
}

/** The saved state: "3 changed files saved to a recovery snapshot, 41 KB". */
export function savedChangesText(workspace: ThreadHibernatedWorkspace): string | undefined {
  const files = workspace.changedFileCount;
  if (files === undefined) return undefined;
  if (files === 0) return "No uncommitted changes";
  const size = workspace.changedBytes !== undefined ? `, ${formatBytes(workspace.changedBytes)}` : "";
  return `${plural(files, "changed file", "changed files")} saved to a recovery snapshot${size}`;
}

function restoreLede(workspace: ThreadHibernatedWorkspace): ReactNode {
  const files = workspace.changedFileCount ?? 0;
  const checkout = workspace.branch
    ? <>Git checks out <b>{workspace.branch}</b> in the same folder</>
    : "Git checks out its saved commit in the same folder";
  const parts: ReactNode[] = [checkout];
  if (files > 0) parts.push(<>restores the {plural(files, "file", "files")}</>);
  if (workspace.runsSetup) parts.push("runs the project's setup");
  return (
    <>
      Your next message brings it back first: {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? (index === parts.length - 1 ? ", and " : ", ") : null}
          {part}
        </span>
      ))}.
    </>
  );
}

type StepStatus = "done" | "active" | "planned";

function Step(props: { status: StepStatus; children: ReactNode; detail?: ReactNode }) {
  return (
    <li className={`missing-worktree-card__step is-${props.status}`}>
      <span className="missing-worktree-card__step-mark" aria-hidden="true">
        {props.status === "done" ? <CheckIcon size={13} /> : <span className="missing-worktree-card__ring" />}
      </span>
      <span>
        <span className="missing-worktree-card__sr">
          {props.status === "done" ? "Done: " : props.status === "active" ? "In progress: " : "To do: "}
        </span>
        {props.children}
        {props.detail ? <small className="missing-worktree-card__step-detail">{props.detail}</small> : null}
      </span>
    </li>
  );
}

/**
 * Sits above the composer while a thread's checkout is hibernated, and
 * follows the restore through to its end. Reading the thread restores
 * nothing; the next message does, or Restore now. Same family as the
 * missing-worktree card, which takes over if a restore is refused.
 */
export function HibernatedCheckoutCard(props: HibernatedCheckoutCardProps) {
  const headingId = useId();
  const [now] = useState(() => Date.now());
  const [state, setState] = useState<CardState>({ phase: "idle" });
  const { workspace } = props;
  const restoring = workspace.restoring === true || state.phase === "running";
  const blocked = restoring || props.ownerOffline === true;

  const run = async (action: "restore" | "keepAwake") => {
    const request = action === "restore" ? props.onRestore : props.onKeepAwake;
    if (!request) return;
    setState({ phase: "running", action });
    try {
      const response = await request();
      setState(response.restoreError ? { phase: "error", message: response.restoreError } : { phase: "idle" });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const saved = savedChangesText(workspace);
  const removed = removedOutputText(workspace.removedOutput);
  const files = workspace.changedFileCount ?? 0;
  const checkoutDone = workspace.restorePhase === "setup";
  const owner = props.ownerLabel ? `On ${props.ownerLabel}` : undefined;

  return (
    <section
      aria-busy={restoring}
      aria-labelledby={headingId}
      className={`missing-worktree-card missing-worktree-card--hibernated${restoring ? " missing-worktree-card--busy" : ""}`}
    >
      <h2 id={headingId} className="missing-worktree-card__heading">
        <MoonIcon size={15} aria-hidden="true" />
        {restoring ? "Restoring checkout" : "Checkout hibernated"}
        <span className="missing-worktree-card__owner">
          {[owner, restoring ? undefined : formatAge(workspace.hibernatedAt, now)].filter(Boolean).join(" · ")}
        </span>
      </h2>
      {restoring ? (
        <ul className="missing-worktree-card__steps" aria-label="Steps">
          <Step status={checkoutDone ? "done" : "active"} detail={workspace.worktreePath}>
            {workspace.branch ? <>Check out <code>{workspace.branch}</code></> : "Check out the saved commit"}
          </Step>
          {files > 0 ? (
            <Step status={checkoutDone ? "done" : "active"} detail="from the recovery snapshot">
              Restore {plural(files, "changed file", "changed files")}
            </Step>
          ) : null}
          {workspace.runsSetup ? (
            <Step status={checkoutDone ? "active" : "planned"}>Run project setup</Step>
          ) : null}
        </ul>
      ) : (
        <>
          <p className="missing-worktree-card__path">{workspace.worktreePath}</p>
          {[workspace.branch, saved, removed].some(Boolean) ? (
            <p className="missing-worktree-card__meta">
              {[workspace.branch, saved, removed].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          <p className="missing-worktree-card__lede">{restoreLede(workspace)}</p>
          {state.phase === "error" ? (
            <p className="missing-worktree-card__error" role="alert">{state.message}</p>
          ) : null}
          {props.ownerOffline ? (
            <p className="missing-worktree-card__meta">
              {props.ownerLabel ?? "The owning machine"} is offline. The checkout comes back when it is.
            </p>
          ) : null}
          {props.onRestore || props.onKeepAwake ? (
            <div className="missing-worktree-card__actions">
              {props.onRestore ? (
                <button className="button button--ghost" disabled={blocked} type="button" onClick={() => void run("restore")}>
                  Restore now
                </button>
              ) : null}
              {props.onKeepAwake ? (
                <button className="button button--ghost" disabled={blocked} type="button" onClick={() => void run("keepAwake")}>
                  Keep it awake
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
