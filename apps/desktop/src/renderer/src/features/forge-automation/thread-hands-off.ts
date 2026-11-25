import { createContext, useContext } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  describeHandsOffMatch,
  findHandsOffMatch,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";

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
