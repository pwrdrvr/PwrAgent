import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BackendSummary, ModelSettingsRecent, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { resolveThreadTodoModelSettings, sameThreadTodoModelSettings } from "@pwragent/shared";
import { CheckIcon, ChevronDownIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { ComposerDropdown } from "../composer/ComposerDropdown";
import { useTodoDispatchContext } from "./TodoDispatchProvider";
import { customTodoDispatchSettings, formatTodoDispatchSettings, todoDispatchRecentResolves } from "./todo-dispatch-model";

type PickerProps = {
  todo: ThreadTodo;
  selection: ReturnType<typeof resolveThreadTodoModelSettings>;
  onPick: (settings: ThreadTodoModelSettings) => void;
  disabled?: boolean;
};

export function TodoModelPicker(props: PickerProps) {
  const { todo, selection } = props;
  const context = useTodoDispatchContext();
  const [open, setOpen] = useState(false);
  const [ownerBackends, setOwnerBackends] = useState<BackendSummary[]>();
  const [recents, setRecents] = useState<ModelSettingsRecent[]>([]);
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const backends = todo.federationTarget ? ownerBackends ?? [] : context.backends;
  const thread = todo.dispatchDefaults?.thread ?? { backend: todo.backend };
  const suggested = resolveThreadTodoModelSettings({ thread, action: todo.action }).settings;
  const hasSuggestion = !sameThreadTodoModelSettings(suggested, thread);
  const differs = !sameThreadTodoModelSettings(selection.settings, thread);
  const label = formatTodoDispatchSettings(selection.settings, backends);
  const close = () => setOpen(false);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });

  // A remote card's catalog and recents belong to the card's owner.
  useEffect(() => {
    if (!todo.federationTarget || !context.api?.listBackends) return;
    let cancelled = false;
    void context.api.listBackends({ federationTarget: todo.federationTarget }).then((response) => {
      if (!cancelled) setOwnerBackends(response.backends);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [context.api, todo.federationTarget]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(undefined);
    void context.api?.listModelSettingsRecents?.({ scope: "todo-dispatch", federationTarget: todo.federationTarget })
      .then((response) => { if (!cancelled) setRecents(response.recents); })
      .catch(() => { if (!cancelled) setError("Recent settings could not be loaded."); });
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)), top: rect.bottom + 6 });
    };
    place();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, context.api, todo.federationTarget]);

  const pickRow = (settings: ThreadTodoModelSettings) => { props.onPick(settings); close(); };
  const row = (settings: ThreadTodoModelSettings, detail?: string, key?: string) => (
    <button type="button" role="menuitemradio" key={key ?? detail}
      className="todo-split__item" aria-checked={sameThreadTodoModelSettings(selection.settings, settings)}
      onClick={() => pickRow(settings)}>
      <span className="todo-split__item-check" aria-hidden="true">
        {sameThreadTodoModelSettings(selection.settings, settings) ? <CheckIcon size={12} /> : null}
      </span>
      <span className="todo-split__item-label">{formatTodoDispatchSettings(settings, backends)}</span>
      {detail ? <span className="todo-model-picker__detail">{detail}</span> : null}
    </button>
  );
  const providers = backends.filter((backend) => backend.available && backend.capabilities.createThread);
  const backend = backends.find((entry) => entry.kind === selection.settings.backend);
  const models = backend?.launchpadOptions?.models ?? [];
  const model = models.find((entry) => entry.id === selection.settings.model);
  const efforts = model?.supportsReasoning === false ? [] : model?.reasoningEfforts ?? backend?.launchpadOptions?.reasoningEfforts ?? [];
  const recentRows = recents.filter((recent) => todoDispatchRecentResolves(recent, backends)).slice(0, 5);
  return (
    <>
      <button ref={triggerRef} type="button" disabled={props.disabled}
        className={`composer-dropdown__button todo-model-picker__chip tooltip-target${differs ? " is-changed" : ""}`}
        aria-label={`Model for the new thread: ${label.replaceAll(" · ", ", ")}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        data-tooltip="Settings for starts here. Start thread on another PwrAgent uses that peer’s defaults."
        onClick={() => setOpen(!open)}>
        <span className="composer-dropdown__label">{label}</span><ChevronDownIcon size={12} />
      </button>
      {open ? createPortal(
        <div ref={menuRef} id={id} className="todo-split__menu todo-model-picker__menu"
          style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 8}px)` }} role="menu" aria-label="Model for the new thread" tabIndex={-1}>
          {row(thread, "This thread")}
          {hasSuggestion ? row(suggested, "Suggested") : null}
          {recentRows.length ? <div className="composer-dropdown__group-label"><span>Recent</span><span>all threads</span></div> : null}
          {recentRows.map((recent, index) => row(recent, undefined, `recent-${index}`))}
          {error ? <p className="todo-model-picker__footnote" role="status">{error}</p> : null}
          <div className="todo-split__separator" role="separator" />
          <div className="composer-dropdown__group-label">Custom</div>
          <div className="todo-model-picker__custom" role="presentation">
            <ComposerDropdown ariaLabel="To-do provider" triggerRole="menuitem" menuPlacement="below"
              options={providers.map((entry) => ({ value: entry.kind, label: formatBackendLabel(entry.kind, backends) }))}
              value={selection.settings.backend} onChange={(value) => {
                const next = providers.find((entry) => entry.kind === value);
                if (next) props.onPick(customTodoDispatchSettings(next));
              }} />
            <ComposerDropdown ariaLabel="To-do model" triggerRole="menuitem" menuPlacement="below"
              options={models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }))}
              value={selection.settings.model ?? ""} onChange={(value) => {
                if (backend) props.onPick(customTodoDispatchSettings(backend, value));
              }} />
            {efforts.length ? <ComposerDropdown ariaLabel="To-do reasoning" triggerRole="menuitem" menuPlacement="below"
              options={efforts.map((effort) => ({ value: effort, label: effort }))}
              value={selection.settings.reasoningEffort ?? ""}
              onChange={(reasoningEffort) => props.onPick({ ...selection.settings, reasoningEffort })} /> : null}
          </div>
          <p className="todo-model-picker__footnote">Starts this card. Later cards in this thread start with the last one you dispatched.</p>
        </div>, document.body,
      ) : null}
    </>
  );
}

export function TodoModelProvenance(props: PickerProps) {
  const { todo, selection } = props;
  const { backends } = useTodoDispatchContext();
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
