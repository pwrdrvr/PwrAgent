import { useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { ThreadDependency } from "@pwragent/shared/contracts/thread-dependencies";
import { CheckIcon, PullRequestIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useCloseOnOutsidePointer, useTodoFactMenuPlacement } from "../thread-todos/TodoFactMenu";
import { useThreadDependencyList } from "../thread-dependencies/useThreadDependencyList";

const isActive = (dependency: ThreadDependency): boolean =>
  dependency.status === "waiting" || dependency.status === "ready" || dependency.status === "dispatching";

/** This thread's own merge build waits: the PR it opened, merged, then built on its target branch. */
export function ownMergeBuildWaits(dependencies: readonly ThreadDependency[], thread: { backend: string; threadId: string }): ThreadDependency[] {
  return dependencies.filter((dependency) => dependency.conditions.some((condition) =>
    condition.when === "merge_build" && condition.backend === thread.backend && condition.threadId === thread.threadId));
}

/**
 * The PR a new merge build watch names: the newest open PR, else the one
 * merged most recently, whose build may still be running.
 */
export function mergeBuildPullRequestUrl(prs: readonly PrSummary[]): string | undefined {
  const merged = (pr: PrSummary) => pr.lifecycleState === "merged" || pr.state === "merged";
  const open = prs.filter((pr) => !merged(pr) && pr.lifecycleState !== "closed" && pr.state !== "closed");
  const newest = (list: PrSummary[], at: (pr: PrSummary) => number | undefined) =>
    [...list].sort((left, right) => (at(right) ?? 0) - (at(left) ?? 0))[0];
  return (newest(open, (pr) => pr.createdAt) ?? newest(prs.filter(merged), (pr) => pr.mergedAt))?.url;
}

/**
 * What Watch Merge Build says for a thread. A thread with an active wait shows
 * it checked, with what will wake it. Without one, the default for every
 * merge (`[git] watch_merge_builds`) applies, unless the operator stopped this
 * thread's watch for its current PR.
 */
export function describeMergeBuildWatch(params: {
  waits: readonly ThreadDependency[];
  defaultOn: boolean;
  prUrl?: string;
}): { checked: boolean; detail: string } {
  const active = params.waits.find(isActive);
  if (active) return { checked: true, detail: active.wakeOn === "failure" ? "Wakes if it fails" : "Wakes on pass or fail" };
  // Forge owner and repository names are case-insensitive.
  const prUrl = params.prUrl?.toLowerCase();
  const stopped = params.waits.some((dependency) => dependency.status === "cancelled"
    && dependency.conditions.some((condition) => condition.when === "merge_build"
      && (!prUrl || !condition.prUrl || condition.prUrl.toLowerCase() === prUrl)));
  if (stopped) return { checked: false, detail: "Off for this PR" };
  return { checked: false, detail: params.defaultOn ? "Default: wakes if it fails" : "Off" };
}

/**
 * The composer's PR button. It used to toggle Auto-fix PR on click; it now
 * opens the PR automation for this thread: Auto-fix, and watching the build
 * of the merge commit once the PR merges. The button stays lit while
 * Auto-fix is on, as before.
 */
export function ComposerPrMenu(props: {
  thread: NavigationThreadSummary;
  desktopApi?: DesktopApi;
  /** `[git] watch_merge_builds`. */
  watchMergeBuildsDefault: boolean;
  /** The PR on the primary workspace a new wait names (`mergeBuildPullRequestUrl`). */
  prUrl?: string;
  className: string;
  tooltip: string;
  ariaDescription?: string;
  autoFix: {
    checked: boolean;
    available: boolean;
    /** Why Auto-fix cannot change, when it cannot. */
    unavailableDetail?: string;
    onToggle: (enabled: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });
  useCloseOnOutsidePointer({ open, triggerRef, menuRef, onClose: close });
  const position = useTodoFactMenuPlacement({ open, triggerRef, menuRef, width: 340 });
  const owner: FederationTarget | undefined = props.thread.federation?.ref.target;
  const ownerId = owner?.scope === "remote" ? owner.instanceId : undefined;
  const target = { backend: props.thread.source, threadId: props.thread.id };
  // Read only while the menu is open: the list refreshes on every
  // dependency event in the window, which a closed button has no use for.
  const list = useThreadDependencyList(props.thread.source, props.thread.id, owner, props.desktopApi, open);
  const waits = ownMergeBuildWaits(list.data?.dependencies ?? [], target);
  const mergeBuild = describeMergeBuildWatch({ waits, defaultOn: props.watchMergeBuildsDefault, prUrl: props.prUrl });
  const canManage = Boolean(props.desktopApi?.manageThreadDependencies) && list.ready && Boolean(list.data);

  /** True when the change went through; a refusal stays on screen. */
  const toggleMergeBuild = async (): Promise<boolean> => {
    const api = props.desktopApi;
    if (!api?.manageThreadDependencies) return false;
    const addressed = { ...target, ...(ownerId ? { federationTarget: { scope: "remote" as const, instanceId: ownerId } } : {}) };
    setError(undefined);
    try {
      if (mergeBuild.checked) {
        for (const dependency of waits.filter(isActive)) {
          await api.manageThreadDependencies({ action: "cancel", ...addressed, dependencyId: dependency.id });
        }
      } else {
        await api.manageThreadDependencies({
          action: "create", ...addressed,
          conditions: [{
            backend: target.backend, threadId: target.threadId, when: "merge_build",
            ...(props.prUrl ? { prUrl: props.prUrl } : {}),
            ...(props.thread.title ? { title: props.thread.title.slice(0, 200) } : {}),
          }],
        });
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${props.className} tooltip-target`}
        aria-label="Pull request automation"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-description={props.ariaDescription}
        data-tooltip={open ? undefined : props.tooltip}
        data-testid="composer-pr-menu"
        onClick={() => setOpen(!open)}
      >
        <PullRequestIcon size={15} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={id}
          className="todo-split__menu todo-model-picker__menu todo-fact-menu composer-pr-menu"
          style={position}
          role="menu"
          aria-label="Pull request automation"
          tabIndex={-1}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            className="todo-split__item"
            aria-checked={props.autoFix.checked}
            aria-disabled={props.autoFix.available ? undefined : true}
            onClick={() => {
              if (!props.autoFix.available) return;
              props.autoFix.onToggle(!props.autoFix.checked);
              close();
            }}
          >
            <span className="todo-split__item-check" aria-hidden="true">
              {props.autoFix.checked ? <CheckIcon size={12} /> : null}
            </span>
            <span className="todo-split__item-label">Auto-fix PR</span>
            <span className="todo-model-picker__detail">
              {props.autoFix.available ? "Repairs failing CI and conflicts" : props.autoFix.unavailableDetail ?? "Unavailable"}
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            className="todo-split__item"
            aria-checked={mergeBuild.checked}
            aria-disabled={canManage ? undefined : true}
            data-testid="composer-pr-menu-merge-build"
            onClick={() => {
              if (!canManage) return;
              void toggleMergeBuild().then((done) => { if (done) close(); });
            }}
          >
            <span className="todo-split__item-check" aria-hidden="true">
              {mergeBuild.checked ? <CheckIcon size={12} /> : null}
            </span>
            <span className="todo-split__item-label">Watch merge build</span>
            <span className="todo-model-picker__detail">{canManage ? mergeBuild.detail : list.error ? "Unavailable" : "Checking…"}</span>
          </button>
          <p className="todo-model-picker__footnote">
            After the PR merges, PwrAgent checks the build of the merge commit on the branch it merged into.
          </p>
          {error ? <p className="todo-model-picker__error" role="alert">{error}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
