import type { AppServerThreadSummary } from "@pwragent/shared";

/** PwrAgent's metadata sidecar; SDK/provider sessions and history are separate. */
export type ClaudeProfileSessionMetadata = {
  cwd: string;
  thread: AppServerThreadSummary;
  ephemeral?: boolean;
};

export interface ClaudeSessionMetadataStorage<T extends ClaudeProfileSessionMetadata> {
  read(id: string): Promise<T>;
  list(options?: { requireComplete?: boolean }): Promise<T[]>;
  changeToken(): Promise<string>;
}

export interface ClaudeProfileThreadStorage {
  listThreads(): Promise<AppServerThreadSummary[]>;
}

/** The metadata owns identity/name/settings; live turn state belongs to the host. */
export function projectClaudeSessionThread(
  { cwd, thread: { workspaceHandoff: _refusal, ...thread } }: ClaudeProfileSessionMetadata,
  active = false,
): AppServerThreadSummary {
  return { ...thread, projectKey: cwd, threadStatus: active ? "active" : "idle" };
}
