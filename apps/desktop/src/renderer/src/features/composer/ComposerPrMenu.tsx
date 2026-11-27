import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import { CheckIcon, PullRequestIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { ipcErrorMessage } from "../../lib/open-path-failure";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useCloseOnOutsidePointer, useTodoFactMenuPlacement } from "../thread-todos/TodoFactMenu";
import { useThreadDependencyList } from "../thread-dependencies/useThreadDependencyList";
import type { AutoFixCoverageEntry } from "./auto-fix-coverage";
import { useForgeAutomationOpener } from "../forge-automation/thread-hands-off";
import {
  cancelMergeBuildWatches,
  createMergeBuildWatch,
  describeMergeBuildWatch,
  mergeBuildPullRequestUrl,
  ownMergeBuildWaits,
} from "../pr-watches/merge-build-watches";

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
  /** Primary-workspace PRs used to choose the PR a new merge build wait names. */
  primaryPrs?: readonly PrSummary[];
  /** Explicit PR URL override when `primaryPrs` is not supplied. */
  prUrl?: string;
  className: string;
  tooltip: string;
  ariaDescription?: string;
  /** Text in place of the PR icon, where a row already names the PR. */
  triggerText?: string;
  testId?: string;
  /** The menu is portaled; a hover-revealed rail stays open while it is. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Where the menu opens from when `openRequest` asks: the row's ⋮ while this
   * button is folded into it.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Bumped to open the menu from `anchorRef`. */
  openRequest?: number;
  autoFix: {
    checked: boolean;
    available: boolean;
    /** Why Auto-fix cannot change, when it cannot. */
    unavailableDetail?: string;
    onToggle: (enabled: boolean) => void;
    /**
     * The PRs Auto-fix covers (`describeAutoFixCoverage`), listed while it is
     * on and covers more than one. Absent where one PR's switch cannot reach
     * the thread's owner.
     */
    coverage?: readonly AutoFixCoverageEntry[];
    onTogglePr?: (prKey: string, enabled: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchored, setAnchored] = useState(false);
  const placementRef: RefObject<HTMLElement | null> =
    anchored && props.anchorRef ? props.anchorRef : triggerRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const sessionRef = useRef(0);
  const id = useId();
  const close = useCallback(() => {
    sessionRef.current += 1;
    openRef.current = false;
    setOpen(false);
    setError(undefined);
  }, []);
  const openMenu = useCallback(() => {
    sessionRef.current += 1;
    openRef.current = true;
    setError(undefined);
    setOpen(true);
  }, []);
  // Only a request made after mount opens the menu: a remount (a thread
  // switch, a refold) keeps the last count and must not reopen it.
  const handledOpenRequestRef = useRef(props.openRequest);
  useEffect(() => {
    if (props.openRequest === handledOpenRequestRef.current) return;
    handledOpenRequestRef.current = props.openRequest;
    if (!props.openRequest) return;
    setAnchored(true);
    openMenu();
  }, [openMenu, props.openRequest]);
  useMenuNavigation({ open, menuRef, triggerRef: placementRef, onClose: close });
  const onOpenChange = props.onOpenChange;
  useEffect(() => {
    if (!open) return undefined;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);
  useCloseOnOutsidePointer({ open, triggerRef: placementRef, menuRef, onClose: close });
  const position = useTodoFactMenuPlacement({ open, triggerRef: placementRef, menuRef, width: 340 });
  const owner: FederationTarget | undefined = props.thread.federation?.ref.target;
  const target = { backend: props.thread.source, threadId: props.thread.id };
  // Read only while the menu is open: the list refreshes on every
  // dependency event in the window, which a closed button has no use for.
  const list = useThreadDependencyList(props.thread.source, props.thread.id, owner, props.desktopApi, open);
  const waits = ownMergeBuildWaits(list.data?.dependencies ?? [], target);
  const prUrl = props.primaryPrs ? mergeBuildPullRequestUrl(props.primaryPrs, waits) : props.prUrl;
  const mergeBuild = describeMergeBuildWatch({ waits, defaultOn: props.watchMergeBuildsDefault, prUrl });
  const listReady = Boolean(props.desktopApi?.manageThreadDependencies) && list.ready && Boolean(list.data);
  const canManage = listReady && !pending;
  // One PR's switch means something only beside another PR Auto-fix covers,
  // or to undo one already made.
  // The thread's project's rules decide which PRs Auto-fix leaves alone.
  const forgeAutomation = useForgeAutomationOpener();
  const forgeProject = open ? forgeAutomation?.projectFor(props.thread) : undefined;
  const togglePr = props.autoFix.onTogglePr;
  const coverage = togglePr && props.autoFix.checked && props.autoFix.available && props.autoFix.coverage
    && (props.autoFix.coverage.length > 1 || props.autoFix.coverage.some((entry) => entry.state !== "on"))
    ? props.autoFix.coverage
    : [];

  /** True when the change went through for the active menu session; a refusal stays on screen. */
  const toggleMergeBuild = async (): Promise<boolean> => {
    const api = props.desktopApi;
    if (!api?.manageThreadDependencies || pending) return false;
    const session = sessionRef.current;
    setPending(true);
    setError(undefined);
    try {
      if (mergeBuild.checked) await cancelMergeBuildWatches(api, props.thread, waits);
      else await createMergeBuildWatch(api, props.thread, prUrl);
      return openRef.current && sessionRef.current === session;
    } catch (reason) {
      if (openRef.current && sessionRef.current === session) {
        setError(ipcErrorMessage(reason));
      }
      return false;
    } finally {
      setPending(false);
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
        data-testid={props.testId ?? "composer-pr-menu"}
        onClick={() => {
          setAnchored(false);
          if (open) close();
          else openMenu();
        }}
      >
        {props.triggerText ?? <PullRequestIcon size={15} aria-hidden="true" />}
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
          {coverage.length > 0 ? (
            <div role="group" aria-label="Pull requests Auto-fix covers">
              <p className="composer-dropdown__group-label" aria-hidden="true">Covers</p>
              {coverage.map((entry) => (
                <button
                  key={entry.prKey}
                  type="button"
                  role="menuitemcheckbox"
                  className="todo-split__item composer-pr-menu__pr"
                  aria-checked={entry.state === "on"}
                  // A hands-off PR changes only through the project's rules.
                  aria-disabled={entry.state === "hands-off" ? true : undefined}
                  onClick={() => {
                    if (entry.state === "hands-off") return;
                    togglePr!(entry.prKey, entry.state === "off");
                    close();
                  }}
                >
                  <span className="todo-split__item-check" aria-hidden="true">
                    {entry.state === "on" ? <CheckIcon size={12} /> : null}
                  </span>
                  <span className="todo-split__item-label composer-pr-menu__pr-label">{entry.label}</span>
                  <span className="todo-model-picker__detail">
                    {entry.state === "hands-off" ? entry.reason : entry.state === "off" ? "Off for this PR" : "Repairs it"}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {forgeProject ? (
            <button
              type="button"
              role="menuitem"
              className="todo-split__item composer-pr-menu__pr"
              data-testid="composer-pr-menu-forge-automation"
              onClick={() => {
                close();
                forgeAutomation!.open(props.thread, triggerRef);
              }}
            >
              <span className="todo-split__item-check" aria-hidden="true" />
              <span className="todo-split__item-label">{`Forge Automation for ${forgeProject}…`}</span>
              <span className="todo-model-picker__detail">Hands-off rules and pause</span>
            </button>
          ) : null}
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
            <span className="todo-model-picker__detail">{pending ? "Saving…" : listReady ? mergeBuild.detail : list.error ? "Unavailable" : "Checking…"}</span>
          </button>
          <p className="todo-model-picker__footnote">
            {props.watchMergeBuildsDefault && !mergeBuild.checked && mergeBuild.detail !== "Off for this PR"
              ? "After the PR merges, PwrAgent checks the build of the merge commit on the branch it merged into. Check to also wake when it passes."
              : "After the PR merges, PwrAgent checks the build of the merge commit on the branch it merged into."}
          </p>
          {error ? <p className="todo-model-picker__error" role="alert">{error}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
