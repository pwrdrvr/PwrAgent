import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX,
  type AppServerBackgroundTask,
  type ThreadSubAgentStatus,
} from "@pwragent/shared";

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
  /** The report Claude settled the task with. */
  summary?: string;
  /** When this process first saw the task; held in memory only. */
  startedAt?: number;
  /** The live background set has named this task. */
  namedLive?: boolean;
};

/** The Sub-agents card for one Claude sub-agent (an Agent tool task). */
export type ClaudeSubAgentCard = {
  monitorId: string;
  taskId: string;
  task: string;
  status: ThreadSubAgentStatus;
  agentName?: string;
  lastMessage?: string;
  startedAt?: number;
};

/** A sub-agent Claude runs for the Agent tool, not a command. */
export function isClaudeSubAgentTask(task: ClaudeTask): boolean {
  return task.taskType === "local_agent";
}

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

  constructor(private readonly now: () => number = Date.now) {}

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
        ambient: message.ambient === true || message.skip_transcript === true || previous?.ambient === true,
        // The CLI sets is_backgrounded only for agents and shells. A monitor
        // or workflow the live set already names is a background task.
        backgrounded: message.is_backgrounded
          ?? (previous?.backgrounded === true || this.liveBackground?.has(message.task_id) === true),
        status: "running",
        startedAt: previous?.startedAt ?? this.now(),
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
        ambient: false, backgrounded: true, status: "running" as const, startedAt: this.now(),
      };
      task.toolUseId ??= message.tool_use_id;
      task.ambient ||= message.ambient === true || message.skip_transcript === true;
      task.status = message.status;
      if (message.summary) task.summary = message.summary;
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
          task.namedLive = true;
          task.taskType ??= entry.task_type;
          task.subagentType ??= entry.subagent_type;
          task.ambient ||= entry.ambient === true;
        } else {
          // Started before this process was observed, or a CLI that sends
          // no edge for this task type.
          this.tasks.set(entry.task_id, {
            taskId: entry.task_id, taskType: entry.task_type, subagentType: entry.subagent_type,
            description: entry.description, ambient: entry.ambient === true,
            backgrounded: true, status: "running", startedAt: this.now(), namedLive: true,
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

  /** Running tasks the Actions panel lists: commands, never sub-agents. */
  actionTasks(): ClaudeTask[] {
    return this.active().filter((task) => !isClaudeSubAgentTask(task));
  }

  /**
   * One card per sub-agent, in start order. A card runs until Claude settles
   * the task, or until the live set that named it drops it, which ends it the
   * way a foreground task ends with its call.
   */
  subAgentCards(): ClaudeSubAgentCard[] {
    return [...this.tasks.values()].flatMap((task) => {
      if (!isClaudeSubAgentTask(task) || task.ambient) return [];
      const dropped = task.status === "running" && task.backgrounded && task.namedLive === true
        && this.liveBackground?.has(task.taskId) === false;
      const status = dropped ? "success" : CLAUDE_SUB_AGENT_STATUS[task.status];
      const lastMessage = task.summary;
      return [{
        monitorId: `${CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}${task.taskId}`,
        taskId: task.taskId,
        task: task.description || task.subagentType || "Claude sub-agent",
        status,
        ...(task.subagentType ? { agentName: task.subagentType } : {}),
        ...(lastMessage && status !== "running" ? { lastMessage } : {}),
        ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
      }];
    });
  }

  /** Ends every running sub-agent when Claude's process goes away. */
  endRunningSubAgents(status: "stopped" | "failed"): void {
    for (const task of this.tasks.values()) {
      if (isClaudeSubAgentTask(task) && task.status === "running") task.status = status;
    }
  }

  /**
   * A foreground task ends with the call that ran it, or at the latest with
   * its native turn; a foreground CLI task need not send a notification.
   */
  settleForeground(toolUseId?: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running" || task.backgrounded || this.liveBackground?.has(task.taskId)) continue;
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
}

const CLAUDE_SUB_AGENT_STATUS: Record<ClaudeTaskStatus, ThreadSubAgentStatus> = {
  running: "running",
  completed: "success",
  failed: "failure",
  stopped: "cancelled",
};

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
    ...(task.backgrounded ? { background: true } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
  };
}
