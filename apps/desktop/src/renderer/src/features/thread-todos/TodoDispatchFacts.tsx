import { useEffect, useState } from "react";
import type {
  BackendSummary,
  CodexSpeed,
  ListThreadTodoDispatchEnvironmentsResponse,
  ThreadTodo,
  ThreadTodoModelSettings,
  ThreadTodoWorkMode,
} from "@pwragent/shared";
import {
  CODEX_SPEED_LABELS,
  THREAD_ENVIRONMENT_NONE,
  resolveThreadTodoModelSettings,
  selectedCodexSpeed,
  threadTodoActionProject,
} from "@pwragent/shared";
import { TodoFactMenu, type TodoFactMenuEntry } from "./TodoFactMenu";
import { TodoModelPicker, TodoModelProvenance } from "./TodoModelPicker";
import { todoDispatchPickKey, useTodoDispatchContext, useTodoMachineBackends } from "./TodoDispatchProvider";
import {
  LOCAL_DISPATCH_MACHINE,
  fitTodoDispatchSettings,
  formatTodoDispatchSettings,
  todoDispatchMachines,
  todoDispatchSpeed,
  type TodoDispatchFit,
  type TodoDispatchMachine,
} from "./todo-dispatch-model";
import type { ThreadTodoInstance, ThreadTodoLocalMachine, ThreadTodoRunOptions } from "./thread-todos-view";

type ModelSelection = ReturnType<typeof resolveThreadTodoModelSettings>;

type EnvironmentState =
  | { status: "loading" }
  | { status: "ready"; response: ListThreadTodoDispatchEnvironmentsResponse }
  | { status: "error"; message: string };

/** What a start-thread card will start with, and the setters its chips call. */
export type TodoDispatchTarget = {
  /**
   * The card's owner predates dispatch choices: it applies the model only,
   * so the card shows Where as a fact and no Speed or Environment.
   */
  legacy: boolean;
  owner: TodoDispatchMachine;
  machine: TodoDispatchMachine;
  machines: TodoDispatchMachine[];
  onOwner: boolean;
  /** The chosen machine's catalog; undefined while it loads. */
  backends?: BackendSummary[];
  /** Undefined on another machine until its catalog loads, or when nothing there can start a thread. */
  model?: ModelSelection;
  fit?: TodoDispatchFit;
  speed?: ReturnType<typeof todoDispatchSpeed> & { changed: boolean };
  workMode: ThreadTodoWorkMode;
  workModeChanged: boolean;
  environment: EnvironmentState & { selected?: string; changed: boolean };
  setMachine: (key: string) => void;
  pickModel: (settings: ThreadTodoModelSettings) => void;
  setSpeed: (speed: CodexSpeed) => void;
  setWorkMode: (workMode: ThreadTodoWorkMode) => void;
  setEnvironment: (environment: string) => void;
  /** The run request's dispatch fields, as the chips show them. */
  runOptions: () => ThreadTodoRunOptions;
};

/**
 * The machine, model, speed, Where and environment a start-thread card
 * starts with. The card's owner is the default machine. Every other choice
 * is kept per machine, so moving the card to a peer and back restores what
 * the operator had: a model fitted to a peer's catalog never replaces the
 * owner's settings.
 */
export function useTodoDispatchTarget(params: {
  todo: ThreadTodo;
  instances?: readonly ThreadTodoInstance[];
  localMachine?: ThreadTodoLocalMachine;
  /** The owner's settings: pick, memory, suggestion or the thread's. */
  ownerSelection: ModelSelection;
  pickOwnerModel: (settings: ThreadTodoModelSettings) => void;
}): TodoDispatchTarget {
  const { todo, ownerSelection } = params;
  const context = useTodoDispatchContext();
  const isHandoff = todo.action?.type === "start_thread";
  const action = todo.action?.type === "start_thread" ? todo.action : undefined;
  const choices = context.choices.get(todoDispatchPickKey(todo)) ?? {};
  const { owner, machines } = todoDispatchMachines({
    ...(todo.federationTarget ? { ownerInstanceId: todo.federationTarget.instanceId } : {}),
    peers: params.instances ?? [],
    ...(params.localMachine ? { local: params.localMachine } : {}),
  });
  const project = threadTodoActionProject(todo);
  const chosen = machines.find((entry) => entry.key === choices.machine && entry.available);
  const machine = chosen && (chosen.key === owner.key || project) ? chosen : owner;
  const onOwner = machine.key === owner.key;
  const machineBackends = useTodoMachineBackends(isHandoff ? machine.key : owner.key);

  let model: ModelSelection | undefined;
  let fit: TodoDispatchFit | undefined;
  if (onOwner) {
    model = ownerSelection;
  } else {
    const picked = choices.models?.[machine.key];
    if (picked) {
      model = { settings: picked, source: "pick" };
    } else {
      const fitted = fitTodoDispatchSettings(ownerSelection.settings, machineBackends);
      if (fitted) {
        model = { settings: fitted.settings, source: "thread" };
        fit = fitted.fit;
      }
    }
  }

  const backend = model ? machineBackends?.find((entry) => entry.kind === model.settings.backend) : undefined;
  const fastAllowed = backend?.codexFastAllowed !== false
    && (machine.key !== LOCAL_DISPATCH_MACHINE || context.localCodexFastAllowed);
  const inheritsSpeed = onOwner && model?.settings.backend === todo.backend;
  const defaultSpeed: CodexSpeed = inheritsSpeed ? selectedCodexSpeed(todo.dispatchDefaults?.threadSpeed ?? {}) : "standard";
  const speedBase = { backend, ...(model?.settings.model ? { model: model.settings.model } : {}), fastAllowed, onOwner };
  const speedChoice = todoDispatchSpeed({ ...speedBase, preferred: choices.speeds?.[machine.key] ?? defaultSpeed });
  const speedDefault = todoDispatchSpeed({ ...speedBase, preferred: defaultSpeed });
  const speed = speedChoice ? { ...speedChoice, changed: speedChoice.speed !== speedDefault?.speed } : undefined;

  const defaultWorkMode: ThreadTodoWorkMode = action?.workMode ?? "local";
  const workMode = choices.workMode ?? defaultWorkMode;

  const legacy = !owner.dispatchTarget;
  const environmentState = useDispatchEnvironments({ todo, machine, onOwner, enabled: isHandoff && !legacy });
  const environmentDefault = environmentState.status === "ready"
    ? environmentState.response.defaultEnvironmentId ?? THREAD_ENVIRONMENT_NONE
    : undefined;
  const environmentChoice = choices.environments?.[machine.key];
  const environmentSelected = environmentState.status === "ready" && environmentState.response.projectFound
    ? environmentChoice !== undefined
      && (environmentChoice === THREAD_ENVIRONMENT_NONE
        || environmentState.response.environments.some((entry) => entry.id === environmentChoice))
      ? environmentChoice
      : environmentDefault
    : undefined;

  const choose = (update: Parameters<typeof context.choose>[1]) => context.choose(todo, update);
  if (legacy) {
    return {
      legacy, owner, machine: owner, machines: [owner], onOwner: true,
      ...(machineBackends ? { backends: machineBackends } : {}),
      model: ownerSelection,
      workMode: defaultWorkMode,
      workModeChanged: false,
      environment: { status: "loading", changed: false },
      setMachine: () => {},
      pickModel: params.pickOwnerModel,
      setSpeed: () => {},
      setWorkMode: () => {},
      setEnvironment: () => {},
      runOptions: () => ({ modelSettings: ownerSelection.settings }),
    };
  }
  return {
    legacy,
    owner,
    machine,
    machines,
    onOwner,
    ...(machineBackends ? { backends: machineBackends } : {}),
    ...(model ? { model } : {}),
    ...(fit ? { fit } : {}),
    ...(speed ? { speed } : {}),
    workMode,
    workModeChanged: workMode !== defaultWorkMode,
    environment: {
      ...environmentState,
      ...(environmentSelected ? { selected: environmentSelected } : {}),
      changed: environmentSelected !== undefined && environmentSelected !== environmentDefault,
    },
    setMachine: (key) => choose((current) => ({ ...current, machine: key === owner.key ? undefined : key })),
    pickModel: (settings) => {
      if (onOwner) {
        params.pickOwnerModel(settings);
        return;
      }
      choose((current) => ({ ...current, models: { ...current.models, [machine.key]: settings } }));
    },
    setSpeed: (next) => choose((current) => ({ ...current, speeds: { ...current.speeds, [machine.key]: next } })),
    setWorkMode: (next) => choose((current) => ({ ...current, workMode: next })),
    setEnvironment: (next) => choose((current) => ({
      ...current, environments: { ...current.environments, [machine.key]: next },
    })),
    runOptions: () => ({
      ...(!onOwner && machine.instanceId ? { startOnInstanceId: machine.instanceId } : {}),
      ...(model ? { modelSettings: model.settings } : {}),
      // The owner inherits the raising thread's exact speed unless the
      // operator changed it; another machine always hears it.
      ...(speed && (!onOwner || speed.changed) ? { speed: speed.speed } : {}),
      // Another machine's project preset must not replace what the chip says.
      ...(!onOwner || workMode !== defaultWorkMode ? { workMode } : {}),
      ...(environmentSelected ? { environment: environmentSelected } : {}),
    }),
  };
}

/**
 * The chosen machine's environments for the card. Its owner reads the
 * checkout the start uses; another machine reads its own copy of the
 * project. Read again when the card moves to another machine.
 */
function useDispatchEnvironments(params: {
  todo: ThreadTodo;
  machine: TodoDispatchMachine;
  onOwner: boolean;
  enabled: boolean;
}): EnvironmentState {
  const { todo, machine, onOwner, enabled } = params;
  const api = useTodoDispatchContext().api;
  const [state, setState] = useState<{ key: string; value: EnvironmentState }>();
  const key = `${todo.id}\u0000${machine.key}`;
  const project = threadTodoActionProject(todo);
  const projectKey = project ? JSON.stringify(project) : "";
  useEffect(() => {
    if (!enabled) return;
    const list = api?.listThreadTodoDispatchEnvironments;
    if (!list) {
      setState({ key, value: { status: "error", message: "This PwrAgent cannot list environments for a to-do." } });
      return;
    }
    const cardProject = projectKey ? JSON.parse(projectKey) as ReturnType<typeof threadTodoActionProject> : undefined;
    if (!onOwner && !cardProject) {
      setState({ key, value: { status: "error", message: "This to-do has no project to find there." } });
      return;
    }
    if (!machine.dispatchTarget) {
      setState({ key, value: { status: "error", message: `Update PwrAgent on ${machine.label} to choose its environments.` } });
      return;
    }
    let cancelled = false;
    setState({ key, value: { status: "loading" } });
    void list(onOwner
      ? { id: todo.id }
      : {
          project: cardProject!,
          ...(machine.key === LOCAL_DISPATCH_MACHINE ? {} : { federationTarget: { scope: "remote", instanceId: machine.key } }),
        })
      .then((response) => {
        if (!cancelled) setState({ key, value: { status: "ready", response } });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ key, value: { status: "error", message: error instanceof Error ? error.message : String(error) } });
        }
      });
    return () => { cancelled = true; };
  }, [api, enabled, key, machine.key, machine.label, machine.dispatchTarget, onOwner, projectKey, todo.id]);
  return state?.key === key ? state.value : { status: "loading" };
}

const FIT_NOTES: Record<Exclude<TodoDispatchFit, "kept">, (from: string, machine: string) => string> = {
  effort: (from, machine) => `${from} has other reasoning levels on ${machine}.`,
  model: (from, machine) => `${from} is not offered on ${machine}. Using its default model.`,
  provider: (from, machine) => `${from} is not set up on ${machine}. Using another provider.`,
};

/**
 * A start-thread card's editable facts: Machine (when another machine can
 * take it), Model, Speed (Codex), Access, Where and Environment.
 */
export function TodoDispatchFacts(props: {
  todo: ThreadTodo;
  target: TodoDispatchTarget;
  access?: string;
  disabled?: boolean;
}) {
  const { todo, target } = props;
  const ownerBackends = useTodoMachineBackends(target.owner.key);
  const project = threadTodoActionProject(todo);
  const environment = target.environment;
  const ready = environment.status === "ready" ? environment.response : undefined;
  const projectLabel = ready?.projectLabel ?? project?.label ?? "Project";
  const machineName = target.machine.label;
  const ownerSettings = target.onOwner ? undefined : todo.dispatchDefaults?.thread;

  const machineEntries: TodoFactMenuEntry[] = target.machines.map((entry) => {
    const noProject = entry.key !== target.owner.key && !project;
    return {
      kind: "item",
      key: entry.key,
      label: entry.label,
      checked: entry.key === target.machine.key,
      ...(entry.key === target.owner.key ? { detail: "This thread" }
        : entry.unavailableReason ? { detail: entry.unavailableReason }
        : noProject ? { detail: "No project" } : {}),
      ...(!entry.available || noProject ? { disabled: true } : {}),
      onSelect: () => target.setMachine(entry.key),
    };
  });

  const localLabel = target.onOwner
    ? todo.targetProject ? `${todo.targetProject.label}'s directory` : "This thread's directory"
    : `${projectLabel} checkout`;
  const whereEntries: TodoFactMenuEntry[] = [
    { kind: "item", key: "local", label: localLabel, checked: target.workMode === "local", onSelect: () => target.setWorkMode("local") },
    {
      kind: "item",
      key: "worktree",
      label: "New worktree",
      ...(target.onOwner ? { detail: "From the default branch" } : {}),
      checked: target.workMode === "worktree",
      onSelect: () => target.setWorkMode("worktree"),
    },
  ];

  const environmentName = (id: string | undefined) => !id || id === THREAD_ENVIRONMENT_NONE
    ? "No environment"
    : ready?.environments.find((entry) => entry.id === id)?.name ?? id;
  const defaultDetail = ready?.defaultSource === "thread" ? "This thread" : "Project default";
  const environmentEntries: TodoFactMenuEntry[] = ready
    ? [
        ...(ready.environments.length === 0
          ? [{ kind: "note" as const, key: "empty", text: `${projectLabel} has no environments on ${machineName}.` }]
          : ready.environments.map((entry): TodoFactMenuEntry => ({
              kind: "item",
              key: entry.id,
              label: entry.name,
              ...(entry.id === ready.defaultEnvironmentId ? { detail: defaultDetail } : {}),
              checked: environment.selected === entry.id,
              onSelect: () => target.setEnvironment(entry.id),
            }))),
        { kind: "separator", key: "separator" },
        {
          kind: "item",
          key: THREAD_ENVIRONMENT_NONE,
          label: "No environment",
          ...(ready.defaultSource === "none" ? { detail: "Default" } : {}),
          checked: environment.selected === THREAD_ENVIRONMENT_NONE,
          onSelect: () => target.setEnvironment(THREAD_ENVIRONMENT_NONE),
        },
      ]
    : [];
  const environmentValue = environment.status === "loading" ? "Loading…"
    : environment.status === "error" ? `${target.machine.label} default`
    : !environment.response.projectFound ? `No ${project?.label ?? "project"} here`
    : environmentName(environment.selected);
  const environmentTooltip = environment.status === "error"
    ? `Environments could not be read on ${machineName}: ${environment.message} The start uses that machine's default.`
    : environment.status === "ready" && !environment.response.projectFound
      ? `${machineName} has no project named ${project?.label ?? "like this one"}.`
      : undefined;

  const speed = target.speed;
  const speedTooltip = speed?.locked === "settings"
    ? `Fast mode is turned off in Settings → Models${target.machine.key === LOCAL_DISPATCH_MACHINE ? "" : ` on ${machineName}`}.`
    : speed?.locked === "model" ? "This model has no Fast mode." : undefined;

  const fitNote = !target.onOwner && target.fit && target.fit !== "kept" && ownerSettings
    ? FIT_NOTES[target.fit](
        target.fit === "provider"
          ? formatTodoDispatchSettings({ backend: ownerSettings.backend }, ownerBackends ?? []).split(" · ")[0]!
          : formatTodoDispatchSettings({ backend: target.model?.settings.backend ?? ownerSettings.backend, model: ownerSettings.model }, ownerBackends ?? [])
            .split(" · ").slice(0, 2).join(" · "),
        machineName,
      )
    : undefined;

  return (
    <>
      <dl className="thread-todo-card__facts">
        {target.machines.length > 1 ? (
          <div className="thread-todo-card__fact thread-todo-card__fact--model">
            <dt>Machine</dt>
            <dd>
              <TodoFactMenu
                label="Machine for the new thread"
                value={target.machine.label}
                entries={machineEntries}
                changed={!target.onOwner}
                disabled={props.disabled}
                testId="todo-dispatch-machine"
              />
            </dd>
          </div>
        ) : null}
        <div className="thread-todo-card__fact thread-todo-card__fact--model">
          <dt>Model</dt>
          <dd>
            {target.onOwner ? (
              <TodoModelPicker todo={todo} selection={target.model!} onPick={target.pickModel} disabled={props.disabled} />
            ) : target.model ? (
              <TodoModelPicker
                todo={todo}
                selection={target.model}
                onPick={target.pickModel}
                disabled={props.disabled}
                backends={target.backends ?? []}
                machineLabel={machineName}
                changed={target.fit !== "kept"}
              />
            ) : (
              <span className="todo-dispatch__pending">
                {target.backends ? `No provider on ${machineName} can start a thread` : "Loading…"}
              </span>
            )}
          </dd>
        </div>
        {speed && !target.legacy ? (
          <div className="thread-todo-card__fact thread-todo-card__fact--model">
            <dt>Speed</dt>
            <dd>
              <TodoFactMenu
                label="Speed for the new thread"
                value={CODEX_SPEED_LABELS[speed.speed]}
                entries={speed.options.map((option) => ({
                  kind: "item",
                  key: option,
                  label: CODEX_SPEED_LABELS[option],
                  checked: option === speed.speed,
                  onSelect: () => target.setSpeed(option),
                }))}
                changed={speed.changed}
                disabled={props.disabled || speed.locked !== undefined}
                {...(speedTooltip ? { tooltip: speedTooltip } : {})}
                testId="todo-dispatch-speed"
              />
            </dd>
          </div>
        ) : null}
        {props.access ? (
          <div className="thread-todo-card__fact">
            <dt>Access</dt>
            <dd>{props.access}</dd>
          </div>
        ) : null}
        {target.legacy ? (
          <div className="thread-todo-card__fact">
            <dt>Where</dt>
            <dd>{target.workMode === "worktree" ? "New worktree" : localLabel}</dd>
          </div>
        ) : null}
        {target.legacy ? null : <div className="thread-todo-card__fact thread-todo-card__fact--model">
          <dt>Where</dt>
          <dd>
            <TodoFactMenu
              label="Where the new thread works"
              value={target.workMode === "worktree" ? "New worktree" : localLabel}
              entries={whereEntries}
              changed={target.workModeChanged}
              disabled={props.disabled}
              testId="todo-dispatch-where"
            />
          </dd>
        </div>}
        {target.legacy ? null : <div className="thread-todo-card__fact thread-todo-card__fact--model">
          <dt>Env</dt>
          <dd>
            <TodoFactMenu
              label="Environment for the new thread"
              value={environmentValue}
              entries={environmentEntries}
              changed={environment.changed}
              disabled={props.disabled || !ready || !ready.projectFound}
              {...(environmentTooltip ? { tooltip: environmentTooltip } : {})}
              testId="todo-dispatch-environment"
            />
          </dd>
        </div>}
      </dl>
      {target.onOwner ? (
        <TodoModelProvenance todo={todo} selection={target.model!} onPick={target.pickModel} disabled={props.disabled} />
      ) : fitNote ? (
        <p className="todo-model-picker__provenance">{fitNote}</p>
      ) : null}
    </>
  );
}
