import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BackendSummary, ModelSettingsRecent, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { resolveThreadTodoModelSettings, sameThreadTodoModelSettings } from "@pwragent/shared";
import { CheckIcon, ChevronDownIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { ComposerDropdown } from "../composer/ComposerDropdown";
import { useTodoDispatchBackends, useTodoDispatchContext } from "./TodoDispatchProvider";
import { customTodoDispatchSettings, formatTodoDispatchSettings, todoDispatchRecentResolves } from "./todo-dispatch-model";

import { placeTodoModelMenu } from "./todo-model-menu-placement";

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
};

export function TodoModelPicker(props: MachinePickerProps) {
  const { todo, selection } = props;
  const context = useTodoDispatchContext();
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<ModelSettingsRecent[]>([]);
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number }>({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
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
  const label = formatTodoDispatchSettings(selection.settings, backends);
  const close = () => setOpen(false);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(undefined);
    void context.api?.listModelSettingsRecents?.({ scope: "todo-dispatch", federationTarget: todo.federationTarget })
      .then((response) => { if (!cancelled) setRecents(response.recents); })
      .catch(() => { if (!cancelled) setError("Recent settings could not be loaded."); });
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, context.api, todo.federationTarget]);

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const facts = triggerRef.current?.closest(".thread-todo-card__facts")?.getBoundingClientRect();
    const next = placeTodoModelMenu({
      trigger,
      alignLeft: facts?.left,
      menuHeight: menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
      menuWidth: menu.offsetWidth || 312,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });
    setPosition((current) => current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight
      ? current : next);
  }, []);

  // Content can grow after Recents loads, or wrap when Custom changes provider.
  useLayoutEffect(() => { if (open) place(); });
  useLayoutEffect(() => {
    if (!open) return;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

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
        data-tooltip={open ? undefined : elsewhere ? `Settings for the start on ${props.machineLabel}.` : "Settings for the start on this thread's machine."}
        onClick={() => setOpen(!open)}>
        <span className="composer-dropdown__label">{label}</span><span className="composer-dropdown__icon" aria-hidden="true"><ChevronDownIcon size={12} /></span>
      </button>
      {open ? createPortal(
        <div ref={menuRef} id={id} className="todo-split__menu todo-model-picker__menu"
          style={position} role="menu" aria-label="Model for the new thread" tabIndex={-1}>
          {offerThread ? row(thread, "This thread") : null}
          {offerSuggestion ? row(suggested, "Suggested") : null}
          {recentRows.length ? <div className="composer-dropdown__group-label"><span>Recent</span><span className="composer-dropdown__group-detail">all threads</span></div> : null}
          {recentRows.map((recent, index) => row(recent, undefined, `recent-${index}`))}
          {error ? <p className="todo-model-picker__error" role="status">{error}</p> : null}
          <div className="todo-split__separator" role="separator" />
          <div className="composer-dropdown__group-label">Custom</div>
          <div className="todo-model-picker__custom" role="presentation">
            <ComposerDropdown ariaLabel="To-do provider" triggerRole="menuitem" menuPlacement="below"
              options={providers.map((entry) => ({ value: entry.kind, label: formatBackendLabel(entry.kind, backends) }))}
              value={selection.settings.backend} onChange={(value) => {
                const next = providers.find((entry) => entry.kind === value);
                if (next) props.onPick(customTodoDispatchSettings(next));
              }} />
            <ComposerDropdown ariaLabel="To-do model" triggerRole="menuitem" menuPlacement="below" disabled={models.length === 0}
              options={models.length ? models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }))
                : [{ value: "", label: "Default model" }]}
              value={selection.settings.model ?? ""} onChange={(value) => {
                if (backend) props.onPick(customTodoDispatchSettings(backend, value));
              }} />
            {efforts.length ? <ComposerDropdown ariaLabel="To-do reasoning" triggerRole="menuitem" menuPlacement="below"
              options={efforts.map((effort) => ({ value: effort, label: effort }))}
              value={selection.settings.reasoningEffort ?? ""}
              onChange={(reasoningEffort) => props.onPick({ ...selection.settings, reasoningEffort })} /> : null}
          </div>
          <p className="todo-model-picker__footnote">
            {elsewhere
              ? `Starts this card on ${props.machineLabel}. Moving the card back keeps this thread's settings.`
              : "Starts this card. Later cards in this thread start with the last one you dispatched."}
          </p>
        </div>, document.body,
      ) : null}
    </>
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
