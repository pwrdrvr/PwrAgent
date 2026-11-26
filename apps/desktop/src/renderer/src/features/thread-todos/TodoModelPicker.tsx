import { useEffect, useMemo, useState } from "react";
import type { CodexSpeed } from "@pwragent/shared/codex-speed";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ModelSettingsRecent } from "@pwragent/shared/contracts/agent";
import type { ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared/contracts/thread-todos";
import {
  buildProviderPickerEntries,
  providerPickerValue,
} from "@pwragent/shared/provider-picker";
import {
  resolveThreadTodoModelSettings,
  sameThreadTodoModelSettings,
} from "@pwragent/shared/contracts/thread-todos";
import { formatOwnerProviderLabel } from "../../lib/thread-provider-label";
import {
  ModelSettingsPicker,
  ModelSettingsQuickList,
  type ModelSettingsQuickRow,
} from "../composer/ModelSettingsPicker";
import { MODEL_DEFAULT_EFFORT, splitEffortChoices } from "../composer/model-settings-picker-model";
import { providerPickerDropdownOptions } from "../composer/provider-picker-options";
import { useTodoDispatchBackends, useTodoDispatchContext } from "./TodoDispatchProvider";
import { customTodoDispatchSettings, formatTodoDispatchSettings, todoDispatchRecentResolves } from "./todo-dispatch-model";

type PickerProps = {
  todo: ThreadTodo;
  selection: ReturnType<typeof resolveThreadTodoModelSettings>;
  onPick: (settings: ThreadTodoModelSettings) => void;
  disabled?: boolean;
};

type MachinePickerProps = PickerProps & {
  /**
   * Another machine's catalog, when the card starts there instead of on
   * its owner. Rows that machine cannot run are left out.
   */
  backends?: BackendSummary[];
  machineLabel?: string;
  /** Marks the chip when the settings differ from the card's own. */
  changed?: boolean;
  /** The card's Codex speed, chosen in the same panel. */
  speed?: {
    options: CodexSpeed[];
    speed: CodexSpeed;
    changed: boolean;
    /** Why only Standard is offered. */
    lockedReason?: string;
    onChange: (speed: CodexSpeed) => void;
  };
};

export function TodoModelPicker(props: MachinePickerProps) {
  const { todo, selection } = props;
  const context = useTodoDispatchContext();
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<ModelSettingsRecent[]>([]);
  const [error, setError] = useState<string>();
  const ownerBackends = useTodoDispatchBackends(todo, open);
  const backends = props.backends ?? ownerBackends;
  const elsewhere = props.machineLabel !== undefined;
  const thread = todo.dispatchDefaults?.thread ?? { backend: todo.backend };
  const suggested = resolveThreadTodoModelSettings({ thread, action: todo.action }).settings;
  const hasSuggestion = !sameThreadTodoModelSettings(suggested, thread);
  const differs = props.changed ?? !sameThreadTodoModelSettings(selection.settings, thread);
  // Another machine offers this thread's settings only when it can run them.
  const offerThread = !elsewhere || todoDispatchRecentResolves(thread, backends);
  const offerSuggestion = hasSuggestion && (!elsewhere || todoDispatchRecentResolves(suggested, backends));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(undefined);
    void context.api?.listModelSettingsRecents?.({ scope: "todo-dispatch", federationTarget: todo.federationTarget })
      .then((response) => { if (!cancelled) setRecents(response.recents); })
      .catch(() => { if (!cancelled) setError("Recent settings could not be loaded."); });
    return () => {
      cancelled = true;
    };
  }, [open, context.api, todo.federationTarget]);

  const providers = useMemo(
    () => backends.filter((backend) => backend.available && backend.capabilities.createThread),
    [backends],
  );
  // Each Codex model provider is its own entry, as in the composer.
  const providerEntries = useMemo(() => buildProviderPickerEntries(providers), [providers]);
  const backend = backends.find((entry) => entry.kind === selection.settings.backend);
  const models = backend?.launchpadOptions?.models ?? [];
  const model = models.find((entry) => entry.id === selection.settings.model);
  const efforts = model?.supportsReasoning === false ? [] : model?.reasoningEfforts ?? backend?.launchpadOptions?.reasoningEfforts ?? [];
  const { stops, hasModelDefault } = splitEffortChoices(efforts);
  const recentRows = recents.filter((recent) => todoDispatchRecentResolves(recent, backends)).slice(0, 5);
  const providerChoices = providerPickerDropdownOptions(providerEntries, backends);
  const providerLabel = formatOwnerProviderLabel(selection.settings.backend, selection.settings.model, backends);
  const stopsFor = (settings: ThreadTodoModelSettings): string[] => {
    const summary = backends.find((entry) => entry.kind === settings.backend);
    const entry = summary?.launchpadOptions?.models?.find((candidate) => candidate.id === settings.model);
    return splitEffortChoices(entry?.supportsReasoning === false
      ? []
      : entry?.reasoningEfforts ?? summary?.launchpadOptions?.reasoningEfforts ?? []).stops;
  };
  const quickRow = (
    settings: ThreadTodoModelSettings,
    key: string,
    close: () => void,
    detail?: string,
  ): ModelSettingsQuickRow => {
    const summary = backends.find((entry) => entry.kind === settings.backend);
    const entry = summary?.launchpadOptions?.models?.find((candidate) => candidate.id === settings.model);
    return {
      key,
      provider: formatOwnerProviderLabel(settings.backend, settings.model, backends),
      model: entry?.label ?? settings.model ?? "Default model",
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort, effortStops: stopsFor(settings) } : {}),
      ...(detail ? { detail } : {}),
      selected: sameThreadTodoModelSettings(selection.settings, settings),
      onPick: () => {
        props.onPick(settings);
        close();
      },
    };
  };
  const speed = props.speed;
  return (
    <ModelSettingsPicker
      ariaLabel="Model for the new thread"
      changed={differs || Boolean(speed?.changed)}
      disabled={props.disabled}
      size="card"
      testId="todo-dispatch-model"
      tooltip={elsewhere ? `Settings for the start on ${props.machineLabel}.` : "Settings for the start on this thread's machine."}
      onOpenChange={setOpen}
      provider={{
        label: providerLabel,
        showInPill: true,
        choices: {
          options: providerChoices.options,
          unavailable: providerChoices.otherOptions,
          unavailableLabel: providerChoices.otherLabel,
          value: providerPickerValue(selection.settings.backend, selection.settings.model),
          onChange: (value) => {
            const entry = providerEntries.find((candidate) => candidate.value === value);
            const next = providers.find((candidate) => candidate.kind === entry?.backend);
            if (!entry || !next) return;
            // A Codex entry names its provider through the model id.
            const codexModel = next.kind === "codex"
              ? (entry.models.find((candidate) => candidate.current) ?? entry.models[0])?.id
              : undefined;
            props.onPick(customTodoDispatchSettings(next, codexModel));
          },
        },
      }}
      model={{
        value: selection.settings.model ?? "",
        label: model?.label ?? selection.settings.model ?? "Default model",
        kind: backend?.kind,
        models,
        emptyOptions: [{ value: "", label: "Default model" }],
        disabled: models.length === 0,
        ...(backend?.kind === "codex" ? { thread: { model: selection.settings.model } } : {}),
        onChange: (value) => {
          if (backend) props.onPick(customTodoDispatchSettings(backend, value, selection.settings.reasoningEffort));
        },
      }}
      {...(stops.length > 0 || hasModelDefault || selection.settings.reasoningEffort ? {
        effort: {
          stops,
          value: selection.settings.reasoningEffort,
          ...(hasModelDefault ? { defaultOption: { value: MODEL_DEFAULT_EFFORT, label: "Default" } } : {}),
          onChange: (reasoningEffort: string) => props.onPick({ ...selection.settings, reasoningEffort }),
        },
      } : {})}
      {...(speed ? {
        speed: {
          options: speed.options,
          value: speed.speed,
          ...(speed.lockedReason ? { lockedReason: speed.lockedReason } : {}),
          onChange: speed.onChange,
        },
      } : {})}
      quickPicks={(close) => (
        <>
          <ModelSettingsQuickList
            label="Ready settings"
            sections={[
              {
                rows: [
                  ...(offerThread ? [quickRow(thread, "thread", close, "This thread")] : []),
                  ...(offerSuggestion ? [quickRow(suggested, "suggested", close, "Suggested")] : []),
                ],
              },
              {
                heading: { title: "Recent", detail: "all threads" },
                rows: recentRows.map((recent, index) => quickRow(recent, `recent-${index}`, close)),
              },
            ]}
          />
          {error ? <p className="todo-model-picker__error" role="status">{error}</p> : null}
        </>
      )}
      footnote={elsewhere
        ? `Starts this card on ${props.machineLabel}. Moving the card back keeps this thread's settings.`
        : "Starts this card. Later cards in this thread start with the last one you dispatched."}
    />
  );
}

export function TodoModelProvenance(props: PickerProps) {
  const { todo, selection } = props;
  const backends = useTodoDispatchBackends(todo);
  const thread = todo.dispatchDefaults?.thread ?? { backend: todo.backend };
  const suggested = resolveThreadTodoModelSettings({ thread, action: todo.action }).settings;
  const hasSuggestion = !sameThreadTodoModelSettings(suggested, thread);
  const differs = !sameThreadTodoModelSettings(selection.settings, thread);
  return (
    differs ? <p className="todo-model-picker__provenance">
        {selection.source === "pick" ? "Picked for this card"
          : selection.source === "memory" && hasSuggestion ? `Last used here. Agent suggested ${formatTodoDispatchSettings(suggested, backends)}`
          : selection.source === "memory" ? "Last used in this thread" : "Suggested by the agent"}
        {" "}<button type="button" className="todo-model-picker__reset" disabled={props.disabled}
          onClick={() => props.onPick(selection.source === "memory" && hasSuggestion ? suggested : thread)}>
          ↺ {selection.source === "memory" && hasSuggestion ? "Use suggestion"
            : selection.source === "memory" ? formatTodoDispatchSettings(thread, backends) : "This thread's settings"}
        </button>
      </p> : null
  );
}
