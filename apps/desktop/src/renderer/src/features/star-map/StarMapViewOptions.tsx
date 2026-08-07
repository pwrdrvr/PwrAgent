import { useEffect, useRef, useState } from "react";
import {
  STAR_MAP_CARD_FIELD_LABELS,
  type StarMapCardFields,
  type StarMapViewPreferences,
} from "./star-map-preferences";

const CARD_FIELD_ORDER: (keyof StarMapCardFields)[] = [
  "primaryDirectory",
  "provider",
  "branch",
  "secondaryDirectories",
  "terminalPullRequests",
];

/**
 * "View" popover for the map: which chips a card carries, and whether
 * offline instances are on the map at all. Card content is a taste call
 * that changes with what the operator is hunting for, so it belongs on
 * the surface rather than buried in Settings.
 */
export function StarMapViewOptions(props: {
  preferences: StarMapViewPreferences;
  onChange: (next: StarMapViewPreferences) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const setCardField = (field: keyof StarMapCardFields, value: boolean) => {
    props.onChange({
      ...props.preferences,
      cardFields: { ...props.preferences.cardFields, [field]: value },
    });
  };

  return (
    <div className="star-map__view-options" ref={containerRef}>
      <button
        type="button"
        className={`star-map__filter-chip${open ? " is-on" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        View
      </button>
      {open ? (
        <div
          className="star-map__view-panel"
          role="dialog"
          aria-label="Star Map view options"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <p className="star-map__view-heading">Layout</p>
          <div className="star-map__layout-switch" role="group" aria-label="Layout">
            {(["lanes", "orbit", "projects"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`star-map__layout-option${
                  props.preferences.layout === mode ? " is-on" : ""
                }`}
                aria-pressed={props.preferences.layout === mode}
                onClick={() =>
                  props.onChange({ ...props.preferences, layout: mode })
                }
              >
                {mode === "lanes"
                  ? "Lanes"
                  : mode === "orbit"
                    ? "Orbit"
                    : "Projects"}
              </button>
            ))}
          </div>
          <p className="star-map__view-heading">Card details</p>
          {CARD_FIELD_ORDER.map((field) => (
            <label key={field} className="star-map__view-row">
              <input
                type="checkbox"
                checked={props.preferences.cardFields[field]}
                onChange={(event) => setCardField(field, event.target.checked)}
              />
              <span>{STAR_MAP_CARD_FIELD_LABELS[field]}</span>
            </label>
          ))}
          <p className="star-map__view-heading">Instances</p>
          <label className="star-map__view-row">
            <input
              type="checkbox"
              checked={props.preferences.hideOfflineInstances}
              onChange={(event) =>
                props.onChange({
                  ...props.preferences,
                  hideOfflineInstances: event.target.checked,
                })
              }
            />
            <span>Hide offline instances</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
