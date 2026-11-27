import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ProviderAccessControl,
  ProviderAccessModeOption,
} from "@pwragent/shared/provider-access-mode";
import { providerAccessOptionTier } from "@pwragent/shared/provider-access-levels";
import { AccessShieldIcon, ChevronDownIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import {
  accessCurrentLevel,
  accessShieldLevel,
  accessStops,
  describeAccessOption,
  stepAccessPicker,
  type AccessStop,
  type AccessPickerEvent,
  type AccessPickerState,
} from "./access-picker-model";
import {
  heldPanelOffset,
  placeModelSettingsPanel,
  type ModelSettingsPanelPlacement,
} from "./model-settings-picker-model";
import { SteppedLevelBar } from "./SteppedLevelBar";

/**
 * The composer's access control: a shield whose fill rises with the level,
 * opening a non-modal dialog with a stepped level bar ordered from least to
 * most freedom. A stop that needs the Full Access confirmation is shown on
 * the bar with Allow and Cancel under it, and the level changes only when
 * Allow commits it.
 *
 * `composer` is the 30px shield in the composer row, opening above it.
 * `card` is a 22px chip naming the level beside the shield, for a to-do
 * card or a Star Map chat card: its panel portals to the body and opens
 * below, or above when there is no room, like the model pill's.
 */
export type AccessPickerProps = {
  control: ProviderAccessControl;
  size?: "composer" | "card";
  backend: AppServerBackendKind | undefined;
  /** "this thread" or "new thread", beside the panel's title. */
  scope: string;
  disabled?: boolean;
  /** Whether committing this option first needs the operator's Allow. */
  needsConfirmation: (option: ProviderAccessModeOption) => boolean;
  /** `confirmed` is true when the operator clicked Allow Full Access. */
  onCommit: (option: ProviderAccessModeOption, confirmed: boolean) => void;
  /** The sentence under the bar; `describeAccessOption` by default. */
  describe?: (option: ProviderAccessModeOption) => string | undefined;
  /** Names the level when the value is not a stop, or while a pick saves. */
  label?: string;
  /** Leads the trigger's accessible name; "Access" by default. */
  ariaLabel?: string;
  testId?: string;
  onOpenChange?: (open: boolean) => void;
};

export function AccessPicker(props: AccessPickerProps) {
  const { control } = props;
  const size = props.size ?? "composer";
  const portalled = size === "card";
  const [open, setOpenState] = useState(false);
  const [placement, setPlacement] = useState<ModelSettingsPanelPlacement>();
  const [picker, setPicker] = useState<AccessPickerState>({});
  const [preview, setPreview] = useState<number>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmFocusedRef = useRef(false);
  // Set by a Tab keydown inside the panel, read by the blur it causes.
  const tabbedRef = useRef(false);
  const panelId = useId();
  const descriptionId = useId();

  const stops = accessStops(control);
  const valueIndex = stops.findIndex((stop) => stop.option.value === control.value);
  const current = accessCurrentLevel(control, stops);
  const chosen = current.option;
  const pendingIndex = picker.pending === undefined
    ? -1
    : stops.findIndex((stop) => stop.option.value === picker.pending);
  const pending = pendingIndex >= 0 ? stops[pendingIndex] : undefined;
  const shownIndex = preview ?? (pending ? pendingIndex : valueIndex);
  const shown = stops[shownIndex];
  // A card's chip stands alone, so it and the panel's headings give the
  // level its full name ("Default Access"); the composer's shield reads
  // "Access: Default". The ticks under the bar are short on both.
  const levelName = (stop: AccessStop | undefined): string | undefined =>
    stop && (portalled ? stop.option.label : stop.label);
  const chosenLabel = props.label
    ?? levelName(stops[valueIndex])
    ?? (portalled && control.selectedOption ? control.selectedOption.label : current.label);
  const name = `${props.ariaLabel ?? "Access"}: ${chosenLabel}`;
  const tooltip = `Access: ${chosenLabel}`;
  const shield = accessShieldLevel(stops, chosen);
  const chosenTier = providerAccessOptionTier(chosen);
  const shownHot = shown?.option.executionMode === "full-access";

  const onOpenChange = props.onOpenChange;
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const close = useCallback(() => {
    setOpen(false);
    setPicker({});
    setPreview(undefined);
    setPlacement(undefined);
  }, [setOpen]);
  // The panel and the trigger, wherever the panel is mounted.
  const inside = (node: Node | null): boolean =>
    Boolean(node && (wrapperRef.current?.contains(node) || panelRef.current?.contains(node)));

  useDismissableLayer({
    open,
    onDismiss: close,
    surfaceRef: wrapperRef,
    triggerRef,
    ...(portalled ? { getPortaledSurface: () => panelRef.current } : {}),
  });

  // Above the composer, the panel hangs from the shield's left edge, shifted
  // left only as far as it takes to stay inside the window. A card's
  // portalled panel is placed by `place` below.
  const [panelOffset, setPanelOffset] = useState(0);
  const placePanel = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const next = heldPanelOffset({
      anchor: trigger.left,
      triggerLeft: trigger.left,
      width: panel.offsetWidth,
      viewportWidth: window.innerWidth,
    });
    setPanelOffset((offset) => (offset === next ? offset : next));
  }, []);
  useLayoutEffect(() => {
    if (!open || portalled) return undefined;
    placePanel();
    window.addEventListener("resize", placePanel);
    return () => window.removeEventListener("resize", placePanel);
  }, [open, placePanel, portalled]);

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

  // A portalled panel hangs from the trigger in window coordinates, and
  // follows it while the card scrolls or the window resizes.
  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!portalled || !trigger || !panel) return;
    const next = placeModelSettingsPanel({
      trigger,
      width: panel.offsetWidth,
      height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      prefer: "below",
    });
    setPlacement((current) => current
      && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight
      ? current
      : next);
  }, [portalled]);
  // Only while open: a closed picker's render must cost the composer
  // nothing, since it re-renders on every keystroke.
  useLayoutEffect(() => {
    if (open) place();
  });
  useLayoutEffect(() => {
    if (!open || !portalled) return undefined;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, portalled]);

  // Opening puts focus on the bar, where a keyboard user starts. A
  // portalled panel stays hidden until it is placed, and a browser will not
  // focus into a hidden element, so the move waits for the placement.
  const placed = !portalled || placement !== undefined;
  useEffect(() => {
    if (open && placed) panelRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
  }, [open, placed]);

  // A pending stop that is no longer offered, or that became the level some
  // other way, has nothing left to confirm.
  const pendingValue = picker.pending;
  useEffect(() => {
    if (pendingValue !== undefined && (pendingValue === control.value || pendingIndex < 0)) setPicker({});
  }, [control.value, pendingIndex, pendingValue]);

  const dispatch = (event: AccessPickerEvent): void => {
    const step = stepAccessPicker(picker, event, {
      stops,
      value: control.value,
      needsConfirmation: props.needsConfirmation,
    });
    setPicker(step.state);
    if (step.commit) {
      const option = stops.find((stop) => stop.option.value === step.commit?.value)?.option;
      if (option) props.onCommit(option, step.commit.confirmed);
    }
    if (step.state.pending === undefined && confirmFocusedRef.current) {
      // Allow and Cancel unmount under the focus; hand it back to the bar.
      panelRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
    }
  };

  const description = shown
    ? props.describe ? props.describe(shown.option) : describeAccessOption(shown.option, props.backend)
    : undefined;
  const panelStyle = !portalled
    ? { left: panelOffset }
    : placement
      ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
      : { left: 0, top: 0, visibility: "hidden" as const };

  const panel = open ? (
    <div
      aria-busy={props.disabled || undefined}
      aria-label="Access"
      className={[
        "access-picker__panel",
        portalled ? "access-picker__panel--below" : "",
      ].filter(Boolean).join(" ")}
      id={panelId}
      ref={panelRef}
      role="dialog"
      style={panelStyle}
      onBlur={(event) => {
        // Tabbing out of both the panel and its trigger closes it. Only
        // the keyboard does: the composer moving focus in code (to the
        // prompt) must not close a panel the operator is still choosing
        // in, or drop a stop waiting for Allow. A click outside closes it
        // on pointerdown instead.
        const tabbed = tabbedRef.current;
        tabbedRef.current = false;
        const next = event.relatedTarget as Node | null;
        if (tabbed && next && !inside(next)) close();
      }}
      onKeyDown={(event) => {
        tabbedRef.current = event.key === "Tab";
      }}
    >
      <div className="access-picker__head">
        <span className="access-picker__title">Access</span>
        <span className="access-picker__scope">{props.scope}</span>
      </div>
      <div aria-hidden="true" className="access-picker__label">
        <span>Level</span>
        <span className="access-picker__label-value">{levelName(shown) ?? chosenLabel}</span>
      </div>
      <div className="access-picker__level">
        <SteppedLevelBar
          ariaDescribedBy={descriptionId}
          ariaLabel="Access level"
          dataAttribute="access"
          disabled={props.disabled}
          hot={shownHot}
          shown={pending ? pendingIndex : undefined}
          stops={stops.map((stop) => ({
            key: stop.option.value,
            tick: stop.tick,
            disabled: stop.disabled,
            ...(stop.reason ? { reason: stop.reason } : {}),
          }))}
          value={valueIndex}
          valueText={chosenLabel}
          onCommit={(index) => {
            const stop = stops[index];
            if (stop) dispatch({ type: "choose", value: stop.option.value });
          }}
          onPreviewChange={setPreview}
        />
        <div
          aria-live="polite"
          className={[
            "access-picker__description",
            shownHot ? "access-picker__description--hot" : "",
          ].filter(Boolean).join(" ")}
          id={descriptionId}
          onBlurCapture={() => {
            confirmFocusedRef.current = false;
          }}
          onFocusCapture={() => {
            confirmFocusedRef.current = true;
          }}
        >
          {shown ? (
            <p>
              <b>{levelName(shown)}.</b>
              {description ? ` ${description}` : null}
            </p>
          ) : null}
          {pending && preview === undefined ? (
            <>
              <p className="access-picker__risk">
                It can reach the network and almost every file on this machine.
              </p>
              <div className="access-picker__confirm">
                <button
                  className="access-picker__allow"
                  disabled={props.disabled}
                  type="button"
                  onClick={() => dispatch({ type: "allow" })}
                >
                  Allow {levelName(pending)}
                </button>
                <button
                  className="access-picker__cancel"
                  type="button"
                  onClick={() => dispatch({ type: "cancel" })}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div
      className={[
        "access-picker",
        `access-picker--${size}`,
        open ? "access-picker--open" : "",
      ].filter(Boolean).join(" ")}
      ref={wrapperRef}
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={name}
        className={[
          "access-picker__trigger",
          `access-picker__trigger--${shield}`,
          chosenTier === "auto" ? "access-picker__trigger--auto" : "",
          shield === "full" ? "access-picker__trigger--danger" : "",
          open ? "" : "tooltip-target",
        ].filter(Boolean).join(" ")}
        data-testid={props.testId}
        data-tooltip={open ? undefined : tooltip}
        data-value={control.value}
        disabled={props.disabled}
        ref={triggerRef}
        type="button"
        value={control.value}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <AccessShieldIcon
          level={shield}
          mark={chosenTier === "plan"}
          size={portalled ? 12 : 16}
        />
        {portalled ? (
          <>
            <span className="access-picker__trigger-label">{chosenLabel}</span>
            <span aria-hidden="true" className="access-picker__trigger-chevron">
              <ChevronDownIcon size={11} />
            </span>
          </>
        ) : null}
      </button>
      {portalled && panel ? createPortal(panel, document.body) : panel}
    </div>
  );
}
