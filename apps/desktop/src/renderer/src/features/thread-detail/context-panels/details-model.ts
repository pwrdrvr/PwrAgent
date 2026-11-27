import type {
  CodexEnvironmentOption,
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared/contracts/navigation";
import type {
  CodexEnvironmentAction,
  CodexEnvironmentActionRun,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { EditedFileGroup } from "../edited-file-groups";
import { isTerminalSubAgent } from "./subagent-format";

/**
 * What the Details tab counts and orders. Pure, so the segment badges, the
 * spine's running dot and the Jobs order can be checked without a render.
 */

/** A sub-agent doing work now: not finished, failed, or waiting on input. */
export function isRunningSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return !isTerminalSubAgent(subAgent)
    && subAgent.status !== "failed"
    && subAgent.status !== "failure"
    && subAgent.status !== "blocked";
}

export type DetailsJobsInput = {
  /** Agent background commands; a listed one is running. */
  terminalCount: number;
  runs: readonly CodexEnvironmentActionRun[];
  subAgents: readonly ThreadSubAgentSummary[];
};

export type DetailsJobsSectionId = "commands" | "subagents" | "scheduled";

export type DetailsJobsSummary = {
  runningCommands: number;
  runningSubAgents: number;
  /** The Jobs segment's count, and what lights the spine's running dot. */
  running: number;
  /** Sections with something running first; otherwise the drawn order. */
  order: DetailsJobsSectionId[];
};

export function summarizeDetailsJobs(input: DetailsJobsInput): DetailsJobsSummary {
  const runningCommands = input.terminalCount
    + input.runs.filter((run) => run.status === "started").length;
  const runningSubAgents = input.subAgents.filter(isRunningSubAgent).length;
  const running: Record<DetailsJobsSectionId, number> = {
    commands: runningCommands,
    subagents: runningSubAgents,
    // Automations report no live run to the thread summary.
    scheduled: 0,
  };
  const drawn: DetailsJobsSectionId[] = ["commands", "subagents", "scheduled"];
  return {
    runningCommands,
    runningSubAgents,
    running: runningCommands + runningSubAgents,
    order: [
      ...drawn.filter((section) => running[section] > 0),
      ...drawn.filter((section) => running[section] === 0),
    ],
  };
}

/**
 * Distinct files across the thread's edit groups: the Changes count. Keyed
 * as the edited-files summary keys them, so the badge and "Edited N files"
 * agree.
 */
export function countChangedFiles(groups: readonly EditedFileGroup[]): number {
  const fileKeys = new Set<string>();
  for (const group of groups) {
    for (const detail of group.details) {
      fileKeys.add(detail.path ?? detail.id);
    }
  }
  return fileKeys.size;
}

export type ThreadEnvironmentModel = {
  /** What the picker lists, including a runtime selection the workspace no longer has. */
  options: CodexEnvironmentOption[];
  /** Listed only because the runtime still holds them; not selectable. */
  missingIds: ReadonlySet<string>;
  selectedEnvironmentId?: string;
  selectedEnvironmentName?: string;
  actions: CodexEnvironmentAction[];
  selectedActionId?: string;
};

/**
 * The thread's environments and commands, as the composer's Environment
 * picker and Run split read them: the workspace's environments, plus the one
 * the runtime holds when the workspace no longer lists it.
 */
export function deriveThreadEnvironmentModel(
  thread: Pick<NavigationThreadSummary, "codexEnvironmentOptions" | "codexEnvironmentRuntime">,
): ThreadEnvironmentModel {
  const runtime = thread.codexEnvironmentRuntime;
  const listed = thread.codexEnvironmentOptions ?? [];
  const selectedOption = listed.find((environment) => environment.id === runtime?.environmentId);
  const runtimeActions = runtime?.actions ?? [];
  const actions = runtimeActions.length > 0 ? runtimeActions : selectedOption?.actions ?? [];
  const selected = selectedOption ?? (runtime?.environmentId
    ? {
        id: runtime.environmentId,
        name: runtime.environmentName ?? runtime.environmentId,
        sourcePath: runtime.sourcePath ?? "",
        actions,
      }
    : undefined);
  const missing = selected && !selectedOption ? selected : undefined;
  return {
    options: missing ? [...listed, missing] : listed,
    missingIds: new Set(missing ? [missing.id] : []),
    selectedEnvironmentId: selected?.id,
    selectedEnvironmentName: selected?.name,
    actions,
    selectedActionId: resolveEnvironmentActionId(
      selected,
      runtime?.environmentId
        ? runtime.selectedActionIdByEnvironmentId?.[runtime.environmentId]
        : undefined,
      runtime?.selectedActionIdByEnvironmentId,
    ),
  };
}

export function resolveEnvironmentActionId(
  environment: CodexEnvironmentOption | undefined,
  actionId: string | undefined,
  actionIdByEnvironmentId: Record<string, string> | undefined,
): string | undefined {
  if (!environment) return undefined;
  if (environment.actions.some((action) => action.id === actionId)) return actionId;
  const mapped = actionIdByEnvironmentId?.[environment.id];
  if (environment.actions.some((action) => action.id === mapped)) return mapped;
  return environment.actions[0]?.id;
}

/** The newest run of each command, which is the state its row shows. */
export function latestRunByAction(
  runs: readonly CodexEnvironmentActionRun[],
): Map<string, CodexEnvironmentActionRun> {
  const latest = new Map<string, CodexEnvironmentActionRun>();
  for (const run of runs) {
    const current = latest.get(run.actionId);
    if (!current || run.startedAt > current.startedAt) latest.set(run.actionId, run);
  }
  return latest;
}
