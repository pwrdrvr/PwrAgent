import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { SubAgentActivityChanges } from "@pwragent/shared/sub-agent-activity-lines";
import { codexNativeSubAgentId } from "./codex-native-subagents";

/** Longest activity line kept; the row shows one ellipsized line of it. */
const ACTIVITY_MAX_LENGTH = 240;

type Item = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;

const basename = (value: unknown): string | undefined => text(value)?.split(/[\\/]/).filter(Boolean).at(-1);

function bounded(line: string): string {
  const points = Array.from(line);
  return points.length > ACTIVITY_MAX_LENGTH ? `${points.slice(0, ACTIVITY_MAX_LENGTH - 1).join("")}…` : line;
}

/**
 * The line a worker's started item reads as, in the words Claude's progress
 * frames use ("Running ls -la", "Reading notes.txt"); undefined for an item
 * that is not a step, such as a message or reasoning. Codex wraps a command in
 * its shell (`/bin/zsh -lc 'ls -la'`); `commandActions` carry the command the
 * worker wrote, and name the file a read opens (captured from codex-cli
 * 0.169.0).
 */
export function codexNativeSubAgentActivityText(item: Item): string | undefined {
  const line = (() => {
    switch (item.type) {
      case "commandExecution": {
        const actions = Array.isArray(item.commandActions)
          ? item.commandActions.filter((action): action is Item => Boolean(action) && typeof action === "object")
          : [];
        const [only] = actions;
        if (actions.length === 1 && only?.type === "read" && (basename(only.name) ?? basename(only.path))) {
          return `Reading ${basename(only.name) ?? basename(only.path)}`;
        }
        if (actions.length === 1 && only?.type === "search" && text(only.query)) {
          return `Searching for ${text(only.query)}`;
        }
        const written = actions.map((action) => text(action.command)).filter(Boolean).join(" && ");
        const command = written || text(item.command);
        return command ? `Running ${command}` : undefined;
      }
      case "fileChange": {
        const paths = Array.isArray(item.changes)
          ? item.changes.flatMap((change) => basename((change as Item | undefined)?.path) ?? [])
          : [];
        if (paths.length === 0) return "Editing files";
        return paths.length === 1 ? `Editing ${paths[0]}` : `Editing ${paths[0]} and ${paths.length - 1} more`;
      }
      case "mcpToolCall":
      case "dynamicToolCall":
      case "functionCall":
      case "toolCall": {
        const tool = text(item.tool) ?? text(item.name);
        return tool ? `Calling ${tool}` : undefined;
      }
      case "webSearch":
        return text(item.query) ? `Searching the web for ${text(item.query)}` : "Searching the web";
      case "imageView":
        return basename(item.path) ? `Viewing ${basename(item.path)}` : undefined;
      default:
        return undefined;
    }
  })();
  return line ? bounded(line) : undefined;
}

const TURN_ENDS = new Set(["turn/completed", "turn/failed", "turn/cancelled"]);

/**
 * What each running Codex native worker is doing now, from the worker
 * thread's own events: the line of the latest step it started, until its turn
 * ends or it goes idle. Codex delivers a worker's items on the same connection
 * as its parent's, under the worker's thread id. Held in memory only.
 */
export class CodexNativeSubAgentActivityTracker {
  /** Each running worker's line and the parent it was published under. */
  private readonly lines = new Map<string, { parent: string; line: string }>();

  /**
   * Applies one Codex notification. Returns the change to publish for the
   * worker's parent, if its line started, changed or ended. A step costs only
   * that worker's line: no other worker's state is read.
   */
  observe(
    notification: AppServerNotification,
    parentOf: (workerThreadId: string) => string | undefined,
  ): { parentThreadId: string; changes: SubAgentActivityChanges } | undefined {
    const params = notification.params as Record<string, unknown> | undefined;
    const worker = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!worker) return undefined;
    const current = this.lines.get(worker);
    if (notification.method === "item/started") {
      // Ask every step: a thread later found to be an ordinary handoff is no
      // longer a worker, and its line leaves the card it was under.
      const parent = parentOf(worker);
      if (!parent || (current && current.parent !== parent)) {
        if (!current) return undefined;
        this.lines.delete(worker);
        return { parentThreadId: current.parent, changes: { activities: [], cleared: [codexNativeSubAgentId(worker)] } };
      }
      const line = codexNativeSubAgentActivityText((params?.item ?? {}) as Item);
      if (!line || line === current?.line) return undefined;
      this.lines.set(worker, { parent, line });
      return { parentThreadId: parent, changes: { activities: [{ monitorId: codexNativeSubAgentId(worker), activity: line }] } };
    }
    if (TURN_ENDS.has(notification.method) || notification.method === "turn/started"
      || notification.method === "thread/archived"
      || (notification.method === "thread/status/changed"
        && (params?.status as { type?: unknown } | undefined)?.type !== "active")) {
      // A new turn has done nothing yet; an ended or idle one does nothing now.
      if (!current) return undefined;
      this.lines.delete(worker);
      return { parentThreadId: current.parent, changes: { activities: [], cleared: [codexNativeSubAgentId(worker)] } };
    }
    return undefined;
  }
}
