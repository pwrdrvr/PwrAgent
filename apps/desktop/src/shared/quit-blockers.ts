import type { FederationRemoteTarget } from "@pwragent/shared";

export type QuitBlockerKind = "turn" | "automation" | "terminal" | "action";

export type QuitBlockerItem = {
  kind: QuitBlockerKind;
  backend: string;
  threadId: string;
  threadKey: string;
  /**
   * Which terminal. Only `kind: "terminal"` carries one, and it is what makes
   * two shells on the same thread two rows rather than one: the thread key no
   * longer identifies a terminal.
   */
  sessionId?: string;
  /** Owning peer when the work is mounted from another PwrAgent instance. */
  target?: FederationRemoteTarget;
  /** Resolved before presentation; falls back to the opaque thread id. */
  title?: string;
  /** The active turn belongs to a worker owned by this thread. */
  isSubAgent?: boolean;
  /** Secondary line, such as a peer label or an action command and pid. */
  detail?: string;
  /** Start time used for elapsed or completion reporting. */
  startedAt?: number;
};

export type QuitBlockerQueueSnapshot = {
  inProgressThreadCount: number;
  automationRunCount: number;
  terminalSessionCount: number;
  actionRunCount: number;
  items: QuitBlockerItem[];
};

export type RevealQuitBlockerRequest = Pick<
  QuitBlockerItem,
  "kind" | "threadKey" | "sessionId" | "target"
>;

export type RevealQuitBlockerResponse = {
  revealed: boolean;
};

/**
 * Stable identity for one row, used as the React key, the title-lookup key,
 * and the handle a reveal request names.
 *
 * The terminal id is part of it because a thread can hold up the quit with
 * more than one shell. Without it both rows key the same, React renders them
 * as one, and a click reveals whichever the lookup happens to find first.
 */
export function quitBlockerItemKey(
  item: Pick<QuitBlockerItem, "kind" | "threadKey" | "sessionId" | "target">,
): string {
  return [
    item.target?.instanceId ?? "local",
    item.kind,
    item.threadKey,
    item.sessionId ?? "",
  ].join("::");
}
