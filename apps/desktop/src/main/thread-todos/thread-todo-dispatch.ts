import path from "node:path";
import type {
  BackendLaunchpadOptions,
  BackendSummary,
  CodexSpeed,
  CodexThreadEnvironmentRuntime,
  ListThreadTodoDispatchEnvironmentsResponse,
  ThreadTodo,
  ThreadTodoProject,
} from "@pwragent/shared";
import {
  CODEX_SPEED_LABELS,
  threadTodoActionProject,
  THREAD_ENVIRONMENT_NONE,
  codexSpeedSettings,
  selectedCodexSpeed,
} from "@pwragent/shared";
import {
  listCodexEnvironmentOptions,
  resolveCodexEnvironmentSelector,
} from "../app-server/codex-environment-config.js";
import { findPeerThreadTodoProject, type ThreadTodoProjectCandidate } from "./thread-todo-projects.js";
import { ThreadTodoError } from "./thread-todo-service.js";

type SpeedSettings = { serviceTier?: string; fastMode?: boolean };

/**
 * The speed a handoff card's local start runs at.
 *
 * Allow Fast mode off in Settings refuses a Fast or Ultrafast pick, and
 * turns an inherited one into Standard. A pick the chosen model's catalog
 * entry says it lacks is refused too; a catalog that says nothing refutes
 * nothing, and the registry still applies its own limits. With no pick, a
 * same-provider start inherits the raising thread's speed.
 */
export function resolveThreadTodoStartSpeed(params: {
  destination?: Pick<BackendSummary, "kind" | "codexFastAllowed">;
  catalog?: Pick<BackendLaunchpadOptions, "models">;
  model?: string;
  requested?: CodexSpeed;
  inherited?: SpeedSettings;
}): SpeedSettings {
  const { requested } = params;
  const inherited = params.inherited ? pickSpeed(params.inherited) : {};
  const codex = params.destination ? params.destination.kind === "codex" : true;
  const fastAllowed = params.destination?.codexFastAllowed !== false;
  if (requested && requested !== "standard") {
    if (!codex) {
      throw new ThreadTodoError("invalid_arguments", `${CODEX_SPEED_LABELS[requested]} speed is available only for Codex threads.`);
    }
    if (!fastAllowed) {
      throw new ThreadTodoError("invalid_arguments", "Fast mode is turned off in Settings → Models on this PwrAgent.");
    }
    const model = params.catalog?.models?.find((entry) => entry.id === params.model);
    const lacks = requested === "fast"
      ? model?.supportsFast === false
      : model !== undefined && !(model.serviceTiers ?? []).includes("ultrafast");
    if (lacks) {
      throw new ThreadTodoError("invalid_arguments", `${model?.label ?? params.model} has no ${CODEX_SPEED_LABELS[requested]} speed.`);
    }
  }
  if (requested) {
    const settings = codexSpeedSettings(requested);
    return {
      fastMode: settings.fastMode,
      ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    };
  }
  if (codex && !fastAllowed && selectedCodexSpeed(inherited) !== "standard") return { fastMode: false };
  return inherited;
}

/** Whether resolving `speed` needs the destination's summary. */
export function threadTodoSpeedNeedsDestination(requested: CodexSpeed | undefined, inherited: SpeedSettings | undefined): boolean {
  return (requested !== undefined && requested !== "standard")
    || (inherited !== undefined && selectedCodexSpeed(pickSpeed(inherited)) !== "standard");
}

function pickSpeed(settings: SpeedSettings): SpeedSettings {
  return {
    ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
  };
}

/**
 * The environment a handoff card's local start runs with, resolved in the
 * checkout the start uses. Absent and `none` start without one. The raising
 * thread's own environment is reused as it is; any other runs its setup in
 * the new thread's workspace.
 */
export async function resolveThreadTodoStartEnvironment(params: {
  requested?: string;
  cwd?: string;
  /** The raising thread's environment, when the start is in its project. */
  source?: CodexThreadEnvironmentRuntime;
  listOptions?: typeof listCodexEnvironmentOptions;
}): Promise<{ runtime: CodexThreadEnvironmentRuntime; rerunSetup: boolean } | undefined> {
  const requested = params.requested?.trim();
  if (!requested || requested.toLowerCase() === THREAD_ENVIRONMENT_NONE) return undefined;
  const cwd = params.cwd?.trim();
  if (!cwd) {
    throw new ThreadTodoError("invalid_arguments", "This to-do has no project directory to run an environment in.");
  }
  const options = await (params.listOptions ?? listCodexEnvironmentOptions)(cwd);
  const resolution = resolveCodexEnvironmentSelector(requested, options, path.basename(cwd));
  if (resolution.kind === "missing") {
    throw new ThreadTodoError("invalid_arguments", resolution.message);
  }
  const environment = resolution.environment;
  if (params.source?.environmentId === environment.id) {
    return { runtime: params.source, rerunSetup: false };
  }
  return {
    runtime: { environmentId: environment.id, environmentName: environment.name, executionTarget: "local" },
    rerunSetup: true,
  };
}

/**
 * The environments a handoff card can start with on this machine, and the
 * one it starts with unless the operator picks.
 *
 * Asked by card id, this machine owns the card: the environments are the
 * ones in the checkout the start uses, and the default is the raising
 * thread's environment when the card stays in its project, else the
 * project's preset. Asked by project, this machine is another start target:
 * it finds its own copy of the project, as Start thread on a peer does, and
 * the default is that copy's preset.
 */
export async function listThreadTodoDispatchEnvironments(
  request: { id?: string; project?: ThreadTodoProject },
  deps: {
    getTodo: (id: string) => ThreadTodo;
    listProjects: () => Promise<ThreadTodoProjectCandidate[]>;
    readThreadEnvironmentId: (thread: { backend: ThreadTodo["backend"]; threadId: string }) => Promise<string | undefined>;
    readProjectPresetId: (directoryKey: string) => Promise<string | undefined>;
    listOptions?: typeof listCodexEnvironmentOptions;
  },
): Promise<ListThreadTodoDispatchEnvironmentsResponse> {
  const listOptions = deps.listOptions ?? listCodexEnvironmentOptions;
  const describe = async (params: {
    cwd?: string;
    project?: { key: string; label: string };
    threadEnvironmentId?: () => Promise<string | undefined>;
  }): Promise<ListThreadTodoDispatchEnvironmentsResponse> => {
    const options = params.cwd ? await listOptions(params.cwd) : [];
    const environments = options.map((option) => ({ id: option.id, name: option.name }));
    const offered = (id: string | undefined) => id !== undefined && environments.some((entry) => entry.id === id);
    const threadId = await params.threadEnvironmentId?.().catch(() => undefined);
    const presetId = params.project ? await deps.readProjectPresetId(params.project.key).catch(() => undefined) : undefined;
    const base = { projectFound: true, ...(params.project ? { projectLabel: params.project.label } : {}), environments };
    if (offered(threadId)) return { ...base, defaultEnvironmentId: threadId, defaultSource: "thread" };
    if (offered(presetId)) return { ...base, defaultEnvironmentId: presetId, defaultSource: "project" };
    return { ...base, defaultSource: "none" };
  };
  if (typeof request.id === "string") {
    const todo = deps.getTodo(request.id);
    if (todo.action?.type !== "start_thread") {
      throw new ThreadTodoError("invalid_arguments", "Only a start-thread card has environments to choose.");
    }
    const project = threadTodoActionProject(todo);
    return await describe({
      cwd: todo.targetProject?.path ?? todo.cwd,
      ...(project ? { project } : {}),
      ...(todo.targetProject ? {} : { threadEnvironmentId: () => deps.readThreadEnvironmentId(todo) }),
    });
  }
  if (!request.project || typeof request.project.label !== "string" || typeof request.project.path !== "string") {
    throw new ThreadTodoError("invalid_arguments", "Name the card or its project.");
  }
  const candidates = await deps.listProjects();
  const counterpart = candidates.find((candidate) => candidate.kind === "directory" && candidate.key === request.project!.key)
    ?? findPeerThreadTodoProject(request.project, candidates);
  if (!counterpart) return { projectFound: false, environments: [], defaultSource: "none" };
  return await describe({
    ...(counterpart.path ? { cwd: counterpart.path } : {}),
    project: { key: counterpart.key, label: counterpart.label },
  });
}
