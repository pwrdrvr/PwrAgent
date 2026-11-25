import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CODEX_SPEED_LABELS, type CodexSpeed } from "@pwragent/shared/codex-speed";
import { formatModelOptionLabel } from "@pwragent/shared/codex-model-providers";
import type { BackendModelOption, BackendSummary } from "@pwragent/shared/contracts/backend";
import { buildModelMenu, modelMenuOtherLabel } from "@pwragent/shared/model-menu";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, HistoryIcon, LightningIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import {
  CODEX_SPEED_DESCRIPTIONS,
  effortMeterHeights,
  effortStopAtPointer,
  effortStopForKey,
  effortStopLabelled,
  heldPanelFoot,
  heldPanelOffset,
  modelSettingsSummary,
  placeModelSettingsPanel,
  type ModelSettingsPanelPlacement,
} from "./model-settings-picker-model";

/** One row of the provider rail or the model list. */
export type ModelSettingsChoice = {
  value: string;
  label: string;
  /** One muted line under the label. */
  description?: string;
  disabled?: boolean;
  /** What the closed pill shows when this row is chosen. Defaults to `label`. */
  selectedLabel?: string;
  /** Longer help, such as why the row cannot be chosen. */
  tooltip?: string;
};

export type ModelSettingsPickerProps = {
  id?: string;
  /** Names the pill and the panel. Defaults to "Model settings". */
  ariaLabel?: string;
  /**
   * `composer` is the 26px composer chip, opening above. `card` is the to-do
   * card's 22px fact chip and `setting` the 30px Settings field; both carry a
   * chevron and open below, portalled out of their clipping containers.
   */
  size?: "composer" | "card" | "setting";
  disabled?: boolean;
  /** The to-do card's "differs from the thread's own settings" rim. */
  changed?: boolean;
  /** Replaces the summary sentence as the closed pill's tooltip. */
  tooltip?: string;
  testId?: string;
  provider?: {
    /** The provider's name: the panel header, and the pill's lead when shown. */
    label: string;
    showInPill?: boolean;
    /** Why the provider is fixed, beside its name in the header. */
    note?: string;
    /** A rail of providers to choose from. Without it the provider is fixed. */
    choices?: {
      options: ModelSettingsChoice[];
      unavailable?: ModelSettingsChoice[];
      unavailableLabel?: string;
      value: string;
      onChange: (value: string) => void;
    };
  };
  model: {
    value: string;
    /** The pill's model name. */
    label: string;
    kind: BackendSummary["kind"] | undefined;
    models: readonly BackendModelOption[];
    /** Set when the choice changes an existing thread; see `buildModelMenu`. */
    thread?: { model?: string };
    /** Rows before the catalog, such as Provider default. */
    leadingOptions?: ModelSettingsChoice[];
    /** Shown when the catalog is empty, so the list still names a choice. */
    emptyOptions?: ModelSettingsChoice[];
    disabled?: boolean;
    onChange: (value: string) => void;
  };
  effort?: {
    /** The bar's stops in catalog order, without a `default` entry. */
    stops: string[];
    value: string | undefined;
    /** A choice that is not a level (the model's or provider's default). */
    defaultOption?: { value: string; label: string };
    disabled?: boolean;
    onChange: (value: string) => void;
  };
  speed?: {
    options: CodexSpeed[];
    value: CodexSpeed;
    /** Shown on the row when only Standard is offered. */
    lockedReason?: string;
    disabled?: boolean;
    onChange: (value: CodexSpeed) => void;
  };
  /**
   * A last row that puts the settings back, such as the profile default.
   * With `current` the settings already match it: the row states so and takes
   * no click, and keeps the panel's height while providers change.
   */
  reset?: { label: string; currentLabel?: string; detail?: string; current?: boolean; onSelect: () => void };
  /** Rows above the editor, such as the to-do card's This thread and Recent. */
  quickPicks?: (close: () => void) => ReactNode;
  /**
   * Whole settings to start from, behind a Recent tab at the top of the
   * provider rail (shown only with one). `startOpen` opens the panel on it.
   */
  recents?: { content: (close: () => void) => ReactNode; startOpen?: boolean };
  footnote?: ReactNode;
  onOpenChange?: (open: boolean) => void;
};

const PANEL_WIDTH = { single: 344, rail: 512 } as const;

/**
 * The model pill: one control for provider, model, reasoning effort and
 * speed. Closed it names the model, shows effort as a meter with its name,
 * and lights a bolt only when Fast or Ultrafast is on. Open it is one
 * non-modal panel where each choice is a single click, and effort is a
 * stepped bar to click or drag. Callers keep their own rules for what a
 * provider or model change restores or drops; the picker only reports picks.
 */
export function ModelSettingsPicker(props: ModelSettingsPickerProps) {
  const size = props.size ?? "composer";
  const portalled = size !== "composer";
  const ariaLabel = props.ariaLabel ?? "Model settings";
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<ModelSettingsPanelPlacement>();
  const [view, setView] = useState<"recent" | "editor">("editor");
  const [abovePlacement, setAbovePlacement] = useState<{ offset: number; rise: number; maxHeight: number }>();
  // Where the panel opened: the pill's left edge and the panel's foot.
  // Cleared when it closes.
  const anchorRef = useRef<{ left: number; foot: number }>(undefined);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Set by a Tab keydown inside the panel, read by the blur it causes.
  const tabbedRef = useRef(false);
  const panelId = useId();
  const onOpenChange = props.onOpenChange;
  const rail = props.provider?.choices;
  const width = rail ? PANEL_WIDTH.rail : PANEL_WIDTH.single;
  const recents = rail ? props.recents : undefined;
  const recentsStartOpen = Boolean(recents?.startOpen);
  const showRecents = Boolean(recents) && view === "recent";

  const setOpenState = useCallback((next: boolean) => {
    // Each opening starts where the host says: on Recent for a new thread.
    if (next) setView(recentsStartOpen ? "recent" : "editor");
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange, recentsStartOpen]);
  const close = useCallback(() => setOpenState(false), [setOpenState]);
  const closeAndFocus = useCallback(() => {
    setOpenState(false);
    triggerRef.current?.focus();
  }, [setOpenState]);

  useDismissableLayer({
    open,
    onDismiss: close,
    surfaceRef: wrapperRef,
    triggerRef,
    ...(portalled ? { getPortaledSurface: () => panelRef.current } : {}),
  });

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    if (portalled) {
      const next = placeModelSettingsPanel({
        trigger,
        width: panel.offsetWidth || width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        prefer: "below",
      });
      setPlacement((current) => current
        && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight
        ? current
        : next);
      return;
    }
    // Above the composer: it opens in line with the pill, over the toolbar's
    // top row, then stays put while it is open. A pick can change the chips
    // before the pill (the access mode, the work mode) and wrap the toolbar
    // onto another row; a panel hung from the pill slid sideways or dropped
    // under the pointer choosing in it, and one held over the pill covered
    // chips the toolbar moved up under it.
    const shelf = wrapperRef.current?.closest<HTMLElement>(".composer__setup")?.getBoundingClientRect().top
      ?? trigger.top;
    const foot = heldPanelFoot({ held: anchorRef.current?.foot, shelfTop: shelf });
    const anchor = anchorRef.current = { left: anchorRef.current?.left ?? trigger.left, foot };
    const offset = heldPanelOffset({
      anchor: anchor.left,
      triggerLeft: trigger.left,
      width: panel.offsetWidth || width,
      viewportWidth: window.innerWidth,
    });
    // The panel hangs from the pill's top edge; this is how far above it.
    const rise = Math.round(trigger.top - foot);
    const maxHeight = Math.max(160, Math.floor(foot - 8));
    setAbovePlacement((current) => current
      && current.offset === offset && current.rise === rise && current.maxHeight === maxHeight
      ? current
      : { offset, rise, maxHeight });
  }, [portalled, width]);

  useLayoutEffect(() => {
    if (open) place();
    else anchorRef.current = undefined;
  });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panelRef.current) observer?.observe(panelRef.current);
    // The toolbar can grow up into an open panel, which then rises.
    const shelf = portalled ? null : wrapperRef.current?.closest<HTMLElement>(".composer__setup");
    if (shelf) observer?.observe(shelf);
    window.addEventListener("resize", place);
    if (portalled) window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, portalled]);

  // Focus goes to the chosen quick pick, else the chosen model: where a
  // keyboard user most often starts. A portalled panel stays hidden until
  // it is placed, and a browser will not focus into a hidden element, so
  // the move waits for the placement, once per opening.
  const focusedOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOpenRef.current = false;
      return;
    }
    if (focusedOpenRef.current || (portalled && !placement)) return;
    focusedOpenRef.current = true;
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('.model-settings__recent [aria-selected="true"]')
      ?? panel?.querySelector<HTMLElement>('.model-settings__recent [role="option"]')
      ?? panel?.querySelector<HTMLElement>('.model-settings__quick [aria-selected="true"]')
      ?? panel?.querySelector<HTMLElement>('[data-model-settings-list="model"] [aria-selected="true"]')
      ?? panel?.querySelector<HTMLElement>('[data-model-settings-list="model"] [role="option"]:not(:disabled)')
      ?? panel?.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']");
    target?.focus({ preventScroll: true });
    // The model list scrolls inside a panel of fixed height; bring the chosen
    // row into it without scrolling the page under the panel.
    const list = target?.closest<HTMLElement>(".model-settings__models");
    if (target && list && list.scrollHeight > list.clientHeight) {
      const row = target.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom + 4;
      else if (row.top < box.top) list.scrollTop -= box.top - row.top + 4;
    }
  }, [open, placement, portalled]);

  const effortIndex = props.effort ? props.effort.stops.indexOf(props.effort.value ?? "") : -1;
  const effortIsDefault = Boolean(props.effort?.defaultOption)
    && props.effort?.value === props.effort?.defaultOption?.value;
  const effortText = !props.effort
    ? undefined
    : effortIndex >= 0
      ? props.effort.stops[effortIndex]
      : effortIsDefault
        ? props.effort.defaultOption?.label.toLowerCase()
        : props.effort.value || undefined;
  // A chosen effort shows even when the catalog lists no levels to draw:
  // a to-do card proposes one for a provider this machine cannot describe.
  const showEffortInPill = Boolean(props.effort && effortText);
  const speed = props.speed?.value;
  const providerInPill = props.provider?.showInPill ? props.provider.label : undefined;
  const summary = modelSettingsSummary({
    label: ariaLabel,
    provider: providerInPill,
    model: props.model.label,
    effort: showEffortInPill ? effortText : undefined,
    speed,
  });

  const panelStyle = portalled
    ? placement
      ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
      : { left: 0, top: 0, visibility: "hidden" as const }
    : abovePlacement
      ? {
        left: abovePlacement.offset,
        bottom: `calc(100% + ${abovePlacement.rise}px)`,
        maxHeight: abovePlacement.maxHeight,
      }
      : undefined;

  const panel = open ? (
    <div
      aria-label={ariaLabel}
      className={[
        "model-settings__panel",
        rail ? "model-settings__panel--rail" : "",
        portalled ? "model-settings__panel--below" : "",
      ].filter(Boolean).join(" ")}
      data-testid={props.testId ? `${props.testId}-panel` : undefined}
      id={panelId}
      aria-busy={props.disabled || undefined}
      ref={panelRef}
      role="dialog"
      style={panelStyle}
      // While the pill is disabled (a save or a start in flight) the open
      // panel stays put but takes no picks: its handlers read the props of
      // the last render, so a second pick would undo the first.
      onClickCapture={(event) => {
        if (!props.disabled) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDownCapture={(event) => {
        if (props.disabled) event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (!props.disabled) return;
        const role = (event.target as HTMLElement).getAttribute("role");
        const picks = event.key === "Enter" || event.key === " "
          || ((role === "slider" || role === "radio") && event.key !== "Tab" && event.key !== "Escape");
        if (!picks) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onBlur={(event) => {
        // Tabbing out of both the panel and its pill closes the panel. Only
        // the keyboard does: the host moving focus in code (a composer
        // sending it to the prompt after a change) must not close the panel
        // the operator is still choosing in. A click outside closes it on
        // pointerdown instead.
        const tabbed = tabbedRef.current;
        tabbedRef.current = false;
        const next = event.relatedTarget as Node | null;
        if (tabbed && next && !panelRef.current?.contains(next) && !wrapperRef.current?.contains(next)) close();
      }}
      onKeyDown={(event) => {
        tabbedRef.current = event.key === "Tab";
        if (event.key !== "Tab" || !portalled) return;
        // A portalled panel is not beside its pill in the DOM. Tab past
        // either end goes back to the pill and closes the panel, so focus
        // carries on from the pill as it would from a menu.
        const tabbables = [...(panelRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ) ?? [])].filter((element) => element.tabIndex >= 0);
        const first = tabbables[0];
        const last = tabbables[tabbables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey ? active === first : active === last) {
          if (event.shiftKey) event.preventDefault();
          triggerRef.current?.focus();
          close();
        }
      }}
    >
      {props.quickPicks ? (
        <div className="model-settings__quick">{props.quickPicks(closeAndFocus)}</div>
      ) : null}
      {rail ? (
        <div className="model-settings__grid">
          <ProviderRail
            choices={rail}
            {...(recents ? { recent: { active: showRecents, onShow: () => setView("recent") } } : {})}
            onActivate={() => setView("editor")}
          />
          <div className="model-settings__main">
            {showRecents && recents ? (
              <div className="model-settings__recent">{recents.content(closeAndFocus)}</div>
            ) : (
              <PanelSections props={props} />
            )}
          </div>
        </div>
      ) : (
        <>
          {props.provider ? (
            <div className="model-settings__head">
              <span className="model-settings__head-name">{props.provider.label}</span>
              {props.provider.note ? (
                <span className="model-settings__head-note">{props.provider.note}</span>
              ) : null}
            </div>
          ) : null}
          <div className="model-settings__main">
            <PanelSections props={props} />
          </div>
        </>
      )}
      {props.reset?.current ? (
        <p className="model-settings__reset model-settings__reset--current">
          <span aria-hidden="true" className="model-settings__reset-mark">✓</span>
          <span>{props.reset.currentLabel ?? props.reset.label}</span>
          {props.reset.detail ? <span className="model-settings__reset-detail">{props.reset.detail}</span> : null}
        </p>
      ) : props.reset ? (
        <button
          className="model-settings__reset"
          type="button"
          onClick={() => {
            props.reset?.onSelect();
          }}
        >
          <span aria-hidden="true" className="model-settings__reset-mark">↺</span>
          <span>{props.reset.label}</span>
          {props.reset.detail ? <span className="model-settings__reset-detail">{props.reset.detail}</span> : null}
        </button>
      ) : null}
      {props.footnote ? <p className="model-settings__footnote">{props.footnote}</p> : null}
    </div>
  ) : null;

  return (
    <div
      className={[
        "model-settings",
        `model-settings--${size}`,
        open ? "model-settings--open" : "",
        props.changed ? "model-settings--changed" : "",
      ].filter(Boolean).join(" ")}
      ref={wrapperRef}
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={summary}
        className={`model-settings__pill${open ? "" : " tooltip-target"}`}
        data-effort={props.effort?.value || undefined}
        data-model={props.model.value || undefined}
        data-provider={props.provider?.choices?.value}
        data-speed={speed}
        data-testid={props.testId}
        data-tooltip={open ? undefined : props.tooltip ?? summary}
        disabled={props.disabled}
        id={props.id}
        ref={triggerRef}
        type="button"
        onClick={() => setOpenState(!open)}
      >
        {providerInPill ? (
          <>
            <span className="model-settings__pill-provider">{providerInPill}</span>
            {" "}
            <span aria-hidden="true" className="model-settings__pill-sep">·</span>
            {" "}
          </>
        ) : null}
        {/* The spaces are words for the text, not layout: a flex row drops
            them. Without them the text reads "Opus 5.5high", which is not
            inside the accessible name, and axe flags the mismatch. */}
        <span className="model-settings__pill-model">{props.model.label}</span>
        {" "}
        {showEffortInPill && props.effort ? (
          <span className="model-settings__pill-effort">
            <EffortMeter count={props.effort.stops.length} index={effortIndex} />
            <span>{effortText}</span>
          </span>
        ) : null}
        {speed && speed !== "standard" ? (
          <span aria-hidden="true" className="model-settings__pill-bolt">
            <LightningIcon size={size === "card" ? 11 : 12} />
            {speed === "ultrafast" ? <LightningIcon size={size === "card" ? 11 : 12} /> : null}
          </span>
        ) : null}
        {size === "composer" ? null : (
          <span aria-hidden="true" className="model-settings__pill-chevron">
            <ChevronDownIcon size={size === "card" ? 11 : 12} />
          </span>
        )}
      </button>
      {portalled && panel ? createPortal(panel, document.body) : panel}
    </div>
  );
}

function EffortMeter(props: { count: number; index: number }) {
  if (props.count === 0) return null;
  const heights = effortMeterHeights(props.count);
  return (
    <span
      aria-hidden="true"
      className={`model-settings__meter${props.index < 0 ? " model-settings__meter--default" : ""}`}
    >
      {heights.map((height, index) => (
        <i
          className={index <= props.index ? "is-on" : undefined}
          // Heights are geometry, not color, so they ride inline.
          key={index}
          style={{ height }}
        />
      ))}
    </span>
  );
}

function PanelSections({ props }: { props: ModelSettingsPickerProps }) {
  const speed = props.speed;
  const showSpeed = Boolean(speed && (speed.options.length > 1 || speed.lockedReason));
  const showEffort = Boolean(props.effort && (props.effort.stops.length > 0 || props.effort.defaultOption));
  return (
    <>
      <ModelList model={props.model} />
      {showEffort && props.effort ? <EffortSection effort={props.effort} /> : null}
      {showSpeed && speed ? <SpeedSection speed={speed} /> : null}
    </>
  );
}

/** Arrow keys walk a list's options; Tab leaves it. */
function handleListKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
  if (options.length === 0) return;
  const at = options.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? options[0]
    : event.key === "End" ? options[options.length - 1]
    : event.key === "ArrowDown" ? options[Math.min(options.length - 1, at + 1)]
    : options[Math.max(0, at - 1)];
  event.preventDefault();
  event.stopPropagation();
  next?.focus();
}

function ChoiceOption(props: {
  choice: ModelSettingsChoice;
  selected: boolean;
  tabbable: boolean;
  onPick: (value: string) => void;
  /** Called for every click, the chosen row's included. */
  onActivate?: () => void;
}) {
  const descriptionId = useId();
  return (
    <button
      aria-describedby={props.choice.description ? descriptionId : undefined}
      aria-description={props.choice.tooltip}
      aria-disabled={props.choice.disabled ? true : undefined}
      aria-selected={props.selected}
      className={`model-settings__option${props.choice.tooltip ? " tooltip-target" : ""}`}
      data-tooltip={props.choice.tooltip}
      role="option"
      tabIndex={props.tabbable ? 0 : -1}
      type="button"
      onClick={() => {
        if (props.choice.disabled) return;
        props.onActivate?.();
        if (props.selected) return;
        props.onPick(props.choice.value);
      }}
    >
      <span aria-hidden="true" className="model-settings__check">
        {props.selected ? <CheckIcon size={12} /> : null}
      </span>
      <span className="model-settings__option-body">
        <span className="model-settings__option-label">{props.choice.label}</span>
        {props.choice.description ? (
          <span aria-hidden="true" className="model-settings__option-description" id={descriptionId}>
            {props.choice.description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ChoiceListbox(props: {
  label: string;
  list?: string;
  groups: { label?: string; choices: ModelSettingsChoice[] }[];
  value: string;
  onPick: (value: string) => void;
  onActivate?: () => void;
}) {
  const all = props.groups.flatMap((group) => group.choices);
  const tabbableValue = all.some((choice) => choice.value === props.value)
    ? props.value
    : all.find((choice) => !choice.disabled)?.value;
  const render = (choices: ModelSettingsChoice[]) => choices.map((choice) => (
    <ChoiceOption
      choice={choice}
      key={choice.value}
      selected={choice.value === props.value}
      tabbable={choice.value === tabbableValue}
      onPick={props.onPick}
      {...(props.onActivate ? { onActivate: props.onActivate } : {})}
    />
  ));
  return (
    <div
      aria-label={props.label}
      className="model-settings__listbox"
      data-model-settings-list={props.list}
      role="listbox"
      onKeyDown={handleListKeyDown}
    >
      {props.groups.map((group, index) => group.label ? (
        <div aria-label={group.label} className="model-settings__group" key={group.label} role="group">
          <div aria-hidden="true" className="model-settings__label">{group.label}</div>
          {render(group.choices)}
        </div>
      ) : (
        <div className="model-settings__group-plain" key={`plain-${index}`} role="presentation">
          {render(group.choices)}
        </div>
      ))}
    </div>
  );
}

/** A row that shows more rows in place: Other models, Unavailable providers. */
function Disclosure(props: { label: string; children: ReactNode; startOpen?: boolean }) {
  const [expanded, setExpanded] = useState(Boolean(props.startOpen));
  return (
    <>
      <button
        aria-expanded={expanded}
        className="model-settings__disclosure"
        type="button"
        onClick={() => setExpanded(!expanded)}
      >
        <span aria-hidden="true" className="model-settings__check" />
        <span className="model-settings__option-label">{props.label}</span>
        <span aria-hidden="true" className={`model-settings__disclosure-mark${expanded ? " is-open" : ""}`}>
          <ChevronRightIcon size={11} />
        </span>
      </button>
      {expanded ? props.children : null}
    </>
  );
}

function ProviderRail({ choices, recent, onActivate }: {
  choices: NonNullable<NonNullable<ModelSettingsPickerProps["provider"]>["choices"]>;
  /** The Recent tab above the providers, and whether its rows are shown. */
  recent?: { active: boolean; onShow: () => void };
  /** A click on any provider row, the chosen one's included, shows its editor. */
  onActivate: () => void;
}) {
  const unavailable = choices.unavailable ?? [];
  const unavailableLabel = choices.unavailableLabel ?? "Unavailable";
  return (
    <div className={`model-settings__rail${recent?.active ? " model-settings__rail--recent" : ""}`}>
      {recent ? (
        <>
          <button
            aria-pressed={recent.active}
            className={`model-settings__option model-settings__rail-recent${recent.active ? " is-on" : ""}`}
            type="button"
            onClick={recent.onShow}
          >
            <span aria-hidden="true" className="model-settings__check">
              <HistoryIcon size={12} />
            </span>
            <span className="model-settings__option-label">Recent</span>
          </button>
          <div aria-hidden="true" className="model-settings__separator" />
        </>
      ) : null}
      <div aria-hidden="true" className="model-settings__label">Provider</div>
      <ChoiceListbox
        groups={[{ choices: choices.options }]}
        label="Provider"
        list="provider"
        value={choices.value}
        onActivate={onActivate}
        onPick={choices.onChange}
      />
      {unavailable.length > 0 ? (
        <>
          <div aria-hidden="true" className="model-settings__separator" />
          <Disclosure
            label={unavailableLabel}
            startOpen={unavailable.some((choice) => choice.value === choices.value)}
          >
            <ChoiceListbox
              groups={[{ choices: unavailable }]}
              label={`Provider: ${unavailableLabel}`}
              value={choices.value}
              onActivate={onActivate}
              onPick={choices.onChange}
            />
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}

function ModelList({ model }: { model: ModelSettingsPickerProps["model"] }) {
  const menu = buildModelMenu({ kind: model.kind, models: model.models, thread: model.thread });
  // A menu scoped to one provider names the model alone; an unscoped one
  // qualifies a Codex model provider's models with that provider.
  const toChoice = (option: BackendModelOption): ModelSettingsChoice => ({
    value: option.id,
    label: option.label ?? option.id,
    ...(!model.thread && option.providerLabel ? { selectedLabel: formatModelOptionLabel(option) } : {}),
  });
  const leading = model.leadingOptions ?? [];
  const primary = model.models.length === 0 && model.emptyOptions
    ? [...leading, ...model.emptyOptions.map((choice) => model.disabled ? { ...choice, disabled: true } : choice)]
    : [...leading, ...menu.primary.map(toChoice)];
  const other = menu.other.map(toChoice);
  const groups = menu.providerGroups.map((group) => ({ label: group.label, choices: group.models.map(toChoice) }));
  const otherLabel = modelMenuOtherLabel(model.kind);
  const onPick = (value: string) => {
    if (!model.disabled) model.onChange(value);
  };
  return (
    <section aria-label="Model" className="model-settings__section model-settings__models">
      <div aria-hidden="true" className="model-settings__label">Model</div>
      <ChoiceListbox
        groups={[{ choices: primary }, ...groups]}
        label="Model"
        list="model"
        value={model.value}
        onPick={onPick}
      />
      {other.length > 0 ? (
        <Disclosure label={otherLabel} startOpen={other.some((choice) => choice.value === model.value)}>
          <ChoiceListbox
            groups={[{ choices: other }]}
            label={`Model: ${otherLabel}`}
            list="model"
            value={model.value}
            onPick={onPick}
          />
        </Disclosure>
      ) : null}
    </section>
  );
}

function EffortSection({ effort }: { effort: NonNullable<ModelSettingsPickerProps["effort"]> }) {
  const count = effort.stops.length;
  const index = effort.stops.indexOf(effort.value ?? "");
  const [preview, setPreview] = useState<number>();
  const [hover, setHover] = useState<number>();
  const dragging = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const shown = preview ?? index;
  const isDefault = Boolean(effort.defaultOption) && effort.value === effort.defaultOption?.value;
  const heading = shown >= 0
    ? effort.stops[shown]
    : isDefault
      ? effort.defaultOption?.label
      : effort.value;

  // The segment under the pointer when the event names one; while the track
  // holds pointer capture every event targets the track, so the position
  // along it decides.
  const stopAt = (event: ReactPointerEvent<HTMLElement>): number => {
    const segment = (event.target as HTMLElement).closest<HTMLElement>("[data-effort-stop]");
    if (segment?.dataset.effortStop !== undefined) {
      return Number(segment.dataset.effortStop);
    }
    const rect = trackRef.current?.getBoundingClientRect();
    return effortStopAtPointer(event.clientX, rect?.left ?? 0, rect?.width ?? 0, count);
  };
  const commit = (stop: number | undefined) => {
    if (stop === undefined || stop < 0 || stop >= count) return;
    const value = effort.stops[stop]!;
    if (value !== effort.value) effort.onChange(value);
  };

  return (
    <section aria-label="Effort" className="model-settings__section model-settings__effort">
      <div aria-hidden="true" className="model-settings__label">
        <span>Effort</span>
        {heading ? (
          <span className={`model-settings__label-value${shown >= 0 ? " is-level" : ""}`}>{heading}</span>
        ) : null}
      </div>
      <div className="model-settings__effort-row">
        {effort.defaultOption ? (
          <button
            aria-pressed={isDefault}
            className={`model-settings__effort-default${isDefault ? " is-on" : ""}`}
            disabled={effort.disabled}
            type="button"
            onClick={() => {
              if (!isDefault && effort.defaultOption) effort.onChange(effort.defaultOption.value);
            }}
          >
            {effort.defaultOption.label}
          </button>
        ) : null}
        {count > 0 ? (
          <div className="model-settings__effort-bar">
            <div
              aria-disabled={effort.disabled || undefined}
              aria-label="Effort"
              aria-valuemax={count - 1}
              aria-valuemin={0}
              aria-valuenow={index >= 0 ? index : undefined}
              aria-valuetext={index >= 0 ? effort.stops[index]
                : isDefault ? effort.defaultOption?.label
                : effort.value || "Not set"}
              className={[
                "model-settings__effort-track",
                index < 0 && preview === undefined ? "is-unset" : "",
              ].filter(Boolean).join(" ")}
              ref={trackRef}
              role="slider"
              style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
              tabIndex={effort.disabled ? -1 : 0}
              onKeyDown={(event) => {
                if (effort.disabled) return;
                const next = effortStopForKey(event.key, index, count);
                if (next === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                commit(next);
              }}
              onLostPointerCapture={() => {
                dragging.current = false;
                setPreview(undefined);
              }}
              onPointerDown={(event) => {
                if (effort.disabled || event.button !== 0) return;
                event.preventDefault();
                (event.currentTarget as HTMLElement).focus({ preventScroll: true });
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setPreview(stopAt(event));
                dragging.current = true;
              }}
              onPointerLeave={() => setHover(undefined)}
              onPointerMove={(event) => {
                if (effort.disabled) return;
                const stop = stopAt(event);
                if (dragging.current) setPreview(stop);
                else setHover(stop);
              }}
              onPointerUp={(event) => {
                if (!dragging.current) return;
                const stop = stopAt(event);
                dragging.current = false;
                setPreview(undefined);
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                commit(stop);
              }}
            >
              {effort.stops.map((stop, stopIndex) => (
                <i
                  className={[
                    "model-settings__effort-stop",
                    stopIndex <= shown ? "is-on" : "",
                    preview === undefined && hover !== undefined && stopIndex > shown && stopIndex <= hover
                      ? "is-hover"
                      : "",
                  ].filter(Boolean).join(" ")}
                  data-effort={stop}
                  data-effort-stop={stopIndex}
                  key={stop}
                />
              ))}
            </div>
            <div
              aria-hidden="true"
              className="model-settings__effort-ticks"
              style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
            >
              {effort.stops.map((stop, stopIndex) => (
                <span className={stopIndex === shown ? "is-on" : undefined} key={stop}>
                  {effortStopLabelled(stopIndex, count, shown) ? stop : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const SPEED_BOLTS: Record<CodexSpeed, number> = { standard: 0, fast: 1, ultrafast: 2 };

function SpeedSection({ speed }: { speed: NonNullable<ModelSettingsPickerProps["speed"]> }) {
  const groupRef = useRef<HTMLDivElement>(null);
  const options = speed.options.length > 0 ? speed.options : (["standard"] as CodexSpeed[]);
  return (
    <section aria-label="Speed" className="model-settings__section">
      <div aria-hidden="true" className="model-settings__label">Speed</div>
      <div
        aria-label="Speed"
        className="model-settings__speed"
        ref={groupRef}
        role="radiogroup"
        onKeyDown={(event) => {
          const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
          if (step === 0 || speed.disabled) return;
          event.preventDefault();
          const at = options.indexOf(speed.value);
          const next = options[(at + step + options.length) % options.length]!;
          speed.onChange(next);
          requestAnimationFrame(() => {
            groupRef.current?.querySelector<HTMLElement>(`[data-speed="${next}"]`)?.focus();
          });
        }}
      >
        {options.map((option) => (
          <button
            aria-checked={option === speed.value}
            aria-description={CODEX_SPEED_DESCRIPTIONS[option]}
            className={`model-settings__speed-option tooltip-target${option === speed.value ? " is-on" : ""}`}
            data-tooltip={CODEX_SPEED_DESCRIPTIONS[option]}
            data-speed={option}
            disabled={speed.disabled}
            key={option}
            role="radio"
            tabIndex={option === speed.value ? 0 : -1}
            type="button"
            onClick={() => {
              if (option !== speed.value) speed.onChange(option);
            }}
          >
            {Array.from({ length: SPEED_BOLTS[option] }, (_, index) => (
              <LightningIcon aria-hidden="true" key={index} size={11} />
            ))}
            {CODEX_SPEED_LABELS[option]}
          </button>
        ))}
      </div>
      {speed.lockedReason ? <p className="model-settings__note">{speed.lockedReason}</p> : null}
    </section>
  );
}

/** One ready-made setting in a quick-pick list: provider, model and effort. */
export type ModelSettingsQuickRow = {
  key: string;
  provider?: string;
  model: string;
  effort?: string;
  /** The effort scale the meter draws `effort` on; no meter without it. */
  effortStops?: string[];
  /** A bolt for Fast, two for Ultrafast; nothing for Standard. */
  speed?: CodexSpeed;
  /** Muted text at the row's end, such as "This thread". */
  detail?: string;
  selected: boolean;
  onPick: () => void;
};

/**
 * A short list of whole settings, each one click: the to-do card's This
 * thread, Suggested and Recent rows above the editor. One listbox, so the
 * arrow keys walk every row; a titled section is an ARIA group inside it.
 */
export function ModelSettingsQuickList(props: {
  label: string;
  sections: { heading?: { title: string; detail?: string }; rows: ModelSettingsQuickRow[] }[];
}) {
  const sections = props.sections.filter((section) => section.rows.length > 0);
  const rows = sections.flatMap((section) => section.rows);
  if (rows.length === 0) return null;
  const tabbable = rows.find((row) => row.selected)?.key ?? rows[0]?.key;
  const renderRow = (row: ModelSettingsQuickRow) => {
    const stops = row.effortStops ?? [];
    return (
      <button
        aria-description={row.detail}
        aria-label={[
          row.provider,
          row.model,
          row.effort ? `${row.effort} effort` : undefined,
          row.speed && row.speed !== "standard" ? CODEX_SPEED_LABELS[row.speed] : undefined,
        ].filter(Boolean).join(", ")}
        aria-selected={row.selected}
        className="model-settings__option model-settings__quick-row"
        key={row.key}
        role="option"
        tabIndex={row.key === tabbable ? 0 : -1}
        type="button"
        onClick={row.onPick}
      >
        <span aria-hidden="true" className="model-settings__check">
          {row.selected ? <CheckIcon size={12} /> : null}
        </span>
        <span aria-hidden="true" className="model-settings__quick-summary">
          {row.provider ? (
            <>
              <span className="model-settings__pill-provider">{row.provider}</span>
              <span className="model-settings__pill-sep">·</span>
            </>
          ) : null}
          <span className="model-settings__quick-model">{row.model}</span>
          {row.effort ? (
            <span className="model-settings__pill-effort">
              {stops.length > 0 ? <EffortMeter count={stops.length} index={stops.indexOf(row.effort)} /> : null}
              <span>{row.effort}</span>
            </span>
          ) : null}
          {row.speed && row.speed !== "standard" ? (
            <span className="model-settings__pill-bolt">
              {Array.from({ length: SPEED_BOLTS[row.speed] }, (_, index) => (
                <LightningIcon key={index} size={11} />
              ))}
            </span>
          ) : null}
        </span>
        {row.detail ? <span aria-hidden="true" className="model-settings__quick-detail">{row.detail}</span> : null}
      </button>
    );
  };
  return (
    <div aria-label={props.label} className="model-settings__listbox" role="listbox" onKeyDown={handleListKeyDown}>
      {sections.map((section, index) => section.heading ? (
        <div aria-label={section.heading.title} key={section.heading.title} role="group">
          <div aria-hidden="true" className="model-settings__label">
            <span>{section.heading.title}</span>
            {section.heading.detail ? (
              <span className="model-settings__label-value model-settings__label-value--muted">
                {section.heading.detail}
              </span>
            ) : null}
          </div>
          {section.rows.map(renderRow)}
        </div>
      ) : (
        <div key={`rows-${index}`} role="presentation">{section.rows.map(renderRow)}</div>
      ))}
    </div>
  );
}
