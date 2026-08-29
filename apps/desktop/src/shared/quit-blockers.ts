import type { FederationRemoteTarget } from "@pwragent/shared";

export type QuitBlockerKind = "turn" | "automation" | "terminal" | "action";

export type QuitBlockerItem = {
  kind: QuitBlockerKind;
  backend: string;
  threadId: string;
  threadKey: string;
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
  "kind" | "threadKey" | "target"
>;

export type RevealQuitBlockerResponse = {
  revealed: boolean;
};

export function quitBlockerItemKey(
  item: Pick<QuitBlockerItem, "kind" | "threadKey" | "target">,
): string {
  return [item.target?.instanceId ?? "local", item.kind, item.threadKey].join(
    "::",
  );
}
