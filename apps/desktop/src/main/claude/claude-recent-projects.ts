import type { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";

export const RECENT_PROJECT_CLAUDE_SESSION_LIMIT = 300;

export type RecentClaudeCodeDirectories = {
  directories: Array<{ cwd: string; updatedAt: number }>;
  complete: boolean;
};

/** Project only directory metadata, before the result leaves the SDK's process. */
export async function readRecentClaudeCodeDirectories(
  listSessions: typeof sdkListSessions,
): Promise<RecentClaudeCodeDirectories> {
  try {
    const sessions = await listSessions({
      limit: RECENT_PROJECT_CLAUDE_SESSION_LIMIT,
      includeProgrammatic: false,
    });
    return {
      complete: sessions.length < RECENT_PROJECT_CLAUDE_SESSION_LIMIT,
      directories: sessions.flatMap(({ archived, cwd, lastModified }) =>
        archived === true || !cwd?.trim() ? [] : [{ cwd, updatedAt: lastModified }]),
    };
  } catch {
    // An SDK exception can describe transcript content. Only send our own error text.
    throw new Error("Could not list Claude Code sessions.");
  }
}
