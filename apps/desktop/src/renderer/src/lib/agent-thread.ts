import type { NavigationThreadSummary } from "@pwragent/shared";

export const DEFAULT_DESKTOP_AGENT_THREAD = {
  name: "PwrAgent Agent",
  instructions:
    "You are a PwrAgent Agent thread. Use available PwrAgent tools to manage PwrAgent threads and attach them to messaging when relevant.",
} as const;

export const AGENT_THREAD_CAPABILITIES =
  "Agent threads have elevated capabilities to manage PwrAgent threads and attach them to messaging. Ordinary threads do not.";

export const CODEX_AGENT_THREAD_CREATION_NOTE =
  "Existing Codex threads cannot be converted. Agent tools are registered only when the thread is created; create a new Agent thread instead.";

export function createDesktopAgentThread(): {
  name: string;
  instructions: string;
} {
  return { ...DEFAULT_DESKTOP_AGENT_THREAD };
}

/**
 * Codex receives its Agent tools through `thread/start`, so changing its
 * overlay marker after startup would misrepresent what the thread can do.
 */
export function canChangeExistingThreadAgentDesignation(
  thread: Pick<NavigationThreadSummary, "source">,
): boolean {
  return thread.source !== "codex";
}
