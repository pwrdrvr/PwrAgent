export const DEFAULT_DESKTOP_AGENT_THREAD = {
  name: "PwrAgent Agent",
  instructions:
    "You are a PwrAgent Agent thread. Use available PwrAgent tools to manage PwrAgent threads and attach them to messaging when relevant.",
} as const;

export const AGENT_THREAD_CAPABILITIES =
  "Agent threads have elevated capabilities to manage PwrAgent threads and attach them to messaging. Ordinary threads do not.";

export const CODEX_AGENT_THREAD_CHANGE_NOTE =
  "Change Agent status while the thread is idle. Existing Codex threads require a runtime that supports tool refresh.";

export function createDesktopAgentThread(): {
  name: string;
  instructions: string;
} {
  return { ...DEFAULT_DESKTOP_AGENT_THREAD };
}
