import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerBackgroundTask } from "@pwragent/shared";

export type ClaudeTaskStatus = "running" | "completed" | "failed" | "stopped";

export type ClaudeTask = {
  taskId: string;
  toolUseId?: string;
  taskType?: string;
  subagentType?: string;
  description: string;
  /** Housekeeping the CLI asks hosts to keep out of activity indicators. */
  ambient: boolean;
  backgrounded: boolean;
  status: ClaudeTaskStatus;
  progress?: string;
};

/** A settled task, for the tool call that started it. */
export type ClaudeTaskSettlement = {
  task: ClaudeTask;
  summary: string;
};

/**
 * Tracks the tasks one Claude process runs: shell commands, sub-agents,
 * monitors, and workflows. Claude reports them twice: as task_* edges, and as
 * `background_tasks_changed`, the full set of live background tasks. The CLI
 * documents the set as authoritative, so once it has been seen a background
 * task counts as running only while the set names it. A foreground task is
 * never in the set; its edges alone describe it.
 */
export class ClaudeTaskTracker {
  private readonly tasks = new Map<string, ClaudeTask>();
  private liveBackground?: Set<string>;

  /** Returns the task a notification settled. */
  apply(message: SDKMessage): { settled?: ClaudeTaskSettlement } {
    if (message.type !== "system") return {};
    let settled: ClaudeTaskSettlement | undefined;
    if (message.subtype === "task_started") {
      const previous = this.tasks.get(message.task_id);
      this.tasks.set(message.task_id, {
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? previous?.toolUseId,
        taskType: message.task_type ?? previous?.taskType,
        subagentType: message.subagent_type ?? previous?.subagentType,
        description: message.description || previous?.description || "",
        ambient: message.ambient === true || message.skip_transcript === true,
        backgrounded: message.is_backgrounded === true,
        status: "running",
      });
    } else if (message.subtype === "task_updated") {
      const task = this.tasks.get(message.task_id);
      if (task) {
        if (message.patch.description) task.description = message.patch.description;
        if (message.patch.is_backgrounded !== undefined) task.backgrounded = message.patch.is_backgrounded;
        const status = message.patch.status;
        if (status === "completed" || status === "failed") task.status = status;
        else if (status === "killed") task.status = "stopped";
      }
    } else if (message.subtype === "task_progress") {
      const task = this.tasks.get(message.task_id);
      if (task) {
        const progress = message.summary
          ?? (message.last_tool_name ? `${message.usage.tool_uses} tool uses · last ${message.last_tool_name}` : undefined);
        if (progress) task.progress = progress;
        if (message.description) task.description = message.description;
      }
    } else if (message.subtype === "task_notification") {
      const task = this.tasks.get(message.task_id) ?? {
        taskId: message.task_id, toolUseId: message.tool_use_id, description: "",
        ambient: false, backgrounded: true, status: "running" as const,
      };
      task.toolUseId ??= message.tool_use_id;
      task.ambient ||= message.ambient === true || message.skip_transcript === true;
      task.status = message.status;
      this.tasks.set(task.taskId, task);
      settled = { task, summary: message.summary };
    } else if (message.subtype === "background_tasks_changed") {
      this.liveBackground = new Set(message.tasks.map((entry) => entry.task_id));
      for (const entry of message.tasks) {
        const task = this.tasks.get(entry.task_id);
        if (task) {
          // A finishing task leaves the set after its notification; the set
          // never revives a task that already settled.
          task.backgrounded = true;
          task.ambient ||= entry.ambient === true;
        } else {
          // Started before this process was observed, or a CLI that sends
          // no edge for this task type.
          this.tasks.set(entry.task_id, {
            taskId: entry.task_id, taskType: entry.task_type, subagentType: entry.subagent_type,
            description: entry.description, ambient: entry.ambient === true,
            backgrounded: true, status: "running",
          });
        }
      }
    }
    return { settled };
  }

  /** Running tasks an operator would call activity, oldest first. */
  active(): ClaudeTask[] {
    return [...this.tasks.values()].filter((task) => task.status === "running" && !task.ambient
      && (!task.backgrounded || !this.liveBackground || this.liveBackground.has(task.taskId)));
  }

  /**
   * A foreground task ends with the call that ran it, or at the latest with
   * its native turn; a foreground CLI task need not send a notification.
   */
  settleForeground(toolUseId?: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running" || task.backgrounded) continue;
      if (toolUseId === undefined || task.toolUseId === toolUseId) task.status = "completed";
    }
  }

  /** Whether the call launched a task that now runs in the background. */
  isBackgroundToolUse(toolUseId: string): boolean {
    return [...this.tasks.values()].some((task) => task.toolUseId === toolUseId && task.backgrounded && task.status === "running");
  }

  /** Tool calls whose task has not settled, whether or not it is activity. */
  runningToolUseIds(): Set<string> {
    return new Set([...this.tasks.values()].flatMap((task) =>
      task.status === "running" && task.toolUseId ? [task.toolUseId] : []));
  }

  get(taskId: string): ClaudeTask | undefined {
    return this.tasks.get(taskId);
  }
}

/** The row the Executions panel and quit prompt show for a running task. */
export function claudeTaskRow(task: ClaudeTask, params: { cwd: string; command?: string }): AppServerBackgroundTask {
  const kind = task.taskType === "local_bash" || params.command !== undefined ? "command"
    : task.taskType === "local_agent" ? "agent" : "task";
  return {
    itemId: task.toolUseId ?? task.taskId,
    processId: task.taskId,
    command: params.command ?? (task.description || task.taskType || "Claude task"),
    cwd: params.cwd,
    ...(kind === "command" ? {} : { kind }),
    ...(task.subagentType ? { agentType: task.subagentType } : {}),
    ...(task.progress ? { progress: task.progress } : {}),
  };
}
