import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  describeHandsOffMatch,
  findHandsOffMatch,
  type HandsOffMatch,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import type { NavigationDirectoryView } from "../../lib/navigation-loaded-rows";
import { findThreadProjectDirectory } from "./forge-automation-view";

/**
 * The Forge Automation of the project a thread is filed under, when this
 * window holds it. A peer's thread runs under its owner's projects, which
 * this window does not hold, so the lookup answers undefined for it.
 */
export type ThreadForgeAutomationLookup = (
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "federation">,
) => Pick<ProjectForgeAutomation, "handsOff"> | undefined;

export const ThreadForgeAutomationContext = createContext<ThreadForgeAutomationLookup | undefined>(undefined);

/**
 * Opens the sidebar's Forge Automation dialog for a thread's project. The
 * sidebar owns the one dialog and registers this; other surfaces only link
 * to it, for the projects the sidebar's own menu would offer it on.
 */
export type ForgeAutomationOpener = {
  /** The thread's project label when the dialog can open for it. */
  projectFor: (thread: Pick<NavigationThreadSummary, "linkedDirectories">) => string | undefined;
  /** Focus goes back to `returnFocus` when the dialog closes. */
  open: (
    thread: Pick<NavigationThreadSummary, "linkedDirectories">,
    returnFocus?: RefObject<HTMLElement | null>,
  ) => void;
};

const ForgeAutomationOpenerContext = createContext<ForgeAutomationOpener | undefined>(undefined);
const RegisterForgeAutomationOpenerContext = createContext<
  ((opener: ForgeAutomationOpener | undefined) => void) | undefined
>(undefined);

/**
 * Answers the lookup from this window's project list, so a PR card or Pull
 * requests panel names a hands-off PR as such. Only this instance's own
 * threads: a peer's run under its projects. It also carries the sidebar's
 * Forge Automation opener to the composer menu and the sidebar's PR card.
 */
export function ThreadForgeAutomationProvider(props: {
  directories: readonly NavigationDirectoryView[];
  children: ReactNode;
}) {
  const { directories } = props;
  const lookup = useMemo<ThreadForgeAutomationLookup>(
    () => (thread) => thread.federation
      ? undefined
      : findThreadProjectDirectory(thread, directories)?.forgeAutomation,
    [directories],
  );
  const [opener, setOpener] = useState<ForgeAutomationOpener>();
  return createElement(
    RegisterForgeAutomationOpenerContext.Provider,
    { value: setOpener },
    createElement(
      ForgeAutomationOpenerContext.Provider,
      { value: opener },
      createElement(ThreadForgeAutomationContext.Provider, { value: lookup }, props.children),
    ),
  );
}

/** The sidebar's Forge Automation opener, while a sidebar has registered one. */
export function useForgeAutomationOpener(): ForgeAutomationOpener | undefined {
  return useContext(ForgeAutomationOpenerContext);
}

/**
 * For the sidebar: publishes its dialog as the window's opener while it can
 * edit some project's Forge Automation. `canOpen` is the sidebar's own menu
 * rule for a project row; `open` must keep its identity.
 */
export function usePublishForgeAutomationOpener<
  T extends Pick<NavigationDirectoryView, "key" | "kind" | "label" | "path">,
>(
  directories: readonly T[],
  canOpen: ((directory: T) => boolean) | undefined,
  open: (directory: T, returnFocus?: RefObject<HTMLElement | null>) => void,
): void {
  const register = useContext(RegisterForgeAutomationOpenerContext);
  useEffect(() => {
    if (!register || !canOpen) return;
    const projectOf = (thread: Pick<NavigationThreadSummary, "linkedDirectories">): T | undefined => {
      const directory = findThreadProjectDirectory(thread, directories);
      return directory && canOpen(directory) ? directory : undefined;
    };
    register({
      projectFor: (thread) => projectOf(thread)?.label,
      open: (thread, returnFocus) => {
        const directory = projectOf(thread);
        if (directory) open(directory, returnFocus);
      },
    });
    return () => register(undefined);
  }, [register, directories, canOpen, open]);
}

/**
 * Why the thread's project leaves this PR hands-off ("hands-off, labeled
 * takeover:yes"), or undefined. Auto-fix never repairs such a PR, whatever
 * the thread's own switches say.
 */
export function useThreadPrHandsOff(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "federation"> | undefined,
  pr: PrSummary,
): string | undefined {
  const match = useThreadPrHandsOffMatch(thread, pr);
  return match ? describeHandsOffMatch(match) : undefined;
}

/** The hands-off rule, and the label it matched, behind `useThreadPrHandsOff`. */
export function useThreadPrHandsOffMatch(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "federation"> | undefined,
  pr: PrSummary,
): HandsOffMatch | undefined {
  const lookup = useContext(ThreadForgeAutomationContext);
  const automation = thread && lookup?.(thread);
  return automation?.handsOff?.length ? findHandsOffMatch(automation, pr) : undefined;
}

/** `useThreadPrHandsOff` for a project's automation already in hand. */
export function describePrHandsOff(
  automation: Pick<ProjectForgeAutomation, "handsOff"> | undefined,
  pr: PrSummary,
): string | undefined {
  const match = automation?.handsOff?.length ? findHandsOffMatch(automation, pr) : undefined;
  return match ? describeHandsOffMatch(match) : undefined;
}
