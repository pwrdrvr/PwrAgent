import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  describeHandsOffMatch,
  findHandsOffMatch,
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
 * Answers the lookup from this window's project list, so a PR card or Pull
 * requests panel names a hands-off PR as such. Only this instance's own
 * threads: a peer's run under its projects.
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
  return createElement(ThreadForgeAutomationContext.Provider, { value: lookup }, props.children);
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
  const lookup = useContext(ThreadForgeAutomationContext);
  return describePrHandsOff(thread && lookup?.(thread), pr);
}

/** `useThreadPrHandsOff` for a project's automation already in hand. */
export function describePrHandsOff(
  automation: Pick<ProjectForgeAutomation, "handsOff"> | undefined,
  pr: PrSummary,
): string | undefined {
  const match = automation?.handsOff?.length ? findHandsOffMatch(automation, pr) : undefined;
  return match ? describeHandsOffMatch(match) : undefined;
}
