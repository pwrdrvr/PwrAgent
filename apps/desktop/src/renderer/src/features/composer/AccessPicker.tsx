import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ProviderAccessControl,
  ProviderAccessModeOption,
} from "@pwragent/shared/provider-access-mode";
import { providerAccessOptionTier } from "@pwragent/shared/provider-access-levels";
import { AccessShieldIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import {
  accessCurrentLevel,
  accessShieldLevel,
  accessStops,
  describeAccessOption,
  stepAccessPicker,
  type AccessPickerEvent,
  type AccessPickerState,
} from "./access-picker-model";
import { heldPanelOffset } from "./model-settings-picker-model";
import { SteppedLevelBar } from "./SteppedLevelBar";

/**
 * The composer's access control: a shield whose fill rises with the level,
 * opening a non-modal dialog with a stepped level bar ordered from least to
 * most freedom. A stop that needs the Full Access confirmation is shown on
 * the bar with Allow and Cancel under it, and the level changes only when
 * Allow commits it.
 */
export function AccessPicker(props: {
  control: ProviderAccessControl;
  backend: AppServerBackendKind | undefined;
  /** "this thread" or "new thread", beside the panel's title. */
  scope: string;
  disabled?: boolean;
  /** Whether committing this option first needs the operator's Allow. */
  needsConfirmation: (option: ProviderAccessModeOption) => boolean;
  /** `confirmed` is true when the operator clicked Allow Full Access. */
  onCommit: (option: ProviderAccessModeOption, confirmed: boolean) => void;
}) {
  const { control } = props;
  const [open, setOpen] = useState(false);
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
  const chosenLabel = current.label;
  const name = `Access: ${chosenLabel}`;
  const shield = accessShieldLevel(stops, chosen);
  const chosenTier = providerAccessOptionTier(chosen);
  const shownHot = shown?.option.executionMode === "full-access";

  const close = useCallback(() => {
    setOpen(false);
    setPicker({});
    setPreview(undefined);
  }, []);

  useDismissableLayer({ open, onDismiss: close, surfaceRef: wrapperRef, triggerRef });

  // The panel hangs from the shield's left edge, shifted left only as far as
  // it takes to stay inside the window.
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
    if (!open) return undefined;
    placePanel();
    window.addEventListener("resize", placePanel);
    return () => window.removeEventListener("resize", placePanel);
  }, [open, placePanel]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);

  // Opening puts focus on the bar, where a keyboard user starts.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
  }, [open]);

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

  const description = shown ? describeAccessOption(shown.option, props.backend) : undefined;

  return (
    <div
      className={["access-picker", open ? "access-picker--open" : ""].filter(Boolean).join(" ")}
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
        data-tooltip={open ? undefined : name}
        data-value={control.value}
        disabled={props.disabled}
        ref={triggerRef}
        type="button"
        value={control.value}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <AccessShieldIcon level={shield} mark={chosenTier === "plan"} size={16} />
      </button>
      {open ? (
        <div
          aria-busy={props.disabled || undefined}
          aria-label="Access"
          className="access-picker__panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          style={{ left: panelOffset }}
          onBlur={(event) => {
            // Tabbing out of both the panel and its trigger closes it. Only
            // the keyboard does: the composer moving focus in code (to the
            // prompt) must not close a panel the operator is still choosing
            // in, or drop a stop waiting for Allow. A click outside closes it
            // on pointerdown instead.
            const tabbed = tabbedRef.current;
            tabbedRef.current = false;
            const next = event.relatedTarget as Node | null;
            if (tabbed && next && !wrapperRef.current?.contains(next)) close();
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
            <span className="access-picker__label-value">{shown?.label ?? chosenLabel}</span>
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
                  <b>{shown.label}.</b>
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
                      Allow {pending.label}
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
      ) : null}
    </div>
  );
}
