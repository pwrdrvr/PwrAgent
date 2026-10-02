import { useEffect, useId, useRef, useState } from "react";
import {
  FEDERATION_SHORT_NAME_KEEP_LENGTH,
  FEDERATION_SHORT_NAME_MAX_LENGTH,
  federationShortNameLength,
  normalizeFederationShortName,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * A machine's federation short name: what the Star Map, the Federation
 * popover and the Activity peer chips draw in place of the full label.
 * Shows who chose it, and lets the operator rename it or hand it back to the
 * gateway. Applies immediately and syncs across the federation, like the
 * celestial icon beside it.
 */
export function FederationShortNameField(props: {
  instanceId: string;
  /** The full machine label, which the short name stands in for. */
  label: string;
  shortLabel?: string;
  source?: "auto" | "override";
  desktopApi?: Pick<DesktopApi, "setFederationShortName">;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hintId = useId();
  const renameRef = useRef<HTMLButtonElement>(null);
  const editing = useRef(false);
  // Leaving the editor unmounts the focused input; hand focus back to the
  // control that opened it rather than dropping it to the page.
  useEffect(() => {
    if (draft === undefined && editing.current) renameRef.current?.focus();
    editing.current = draft !== undefined;
  }, [draft]);
  const setter = props.desktopApi?.setFederationShortName;
  const normalized = draft === undefined ? undefined : normalizeFederationShortName(draft);

  const apply = (shortLabel: string | null) => {
    if (!setter) return;
    setSaving(true);
    setter({ instanceId: props.instanceId, shortLabel })
      .then(() => {
        setDraft(undefined);
        props.onChanged();
      })
      .catch((err: unknown) => props.onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  if (draft !== undefined) {
    return (
      <span className="federation-short-name">
        <input
          className="settings-input federation-short-name__input"
          aria-label={`Short name for ${props.label}`}
          aria-describedby={hintId}
          value={draft}
          maxLength={FEDERATION_SHORT_NAME_MAX_LENGTH * 2}
          placeholder={props.shortLabel ?? props.label}
          disabled={saving}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && normalized) {
              event.preventDefault();
              apply(normalized);
            } else if (event.key === "Escape" && !saving) {
              // Claimed, so the Settings layer behind does not close too.
              event.preventDefault();
              event.stopPropagation();
              setDraft(undefined);
            }
          }}
        />
        <button
          className="button button--secondary"
          type="button"
          disabled={saving || !normalized || !setter}
          onClick={() => normalized && apply(normalized)}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          className="button button--ghost"
          type="button"
          disabled={saving}
          onClick={() => setDraft(undefined)}
        >
          Cancel
        </button>
        <span className="federation-short-name__hint" id={hintId}>
          {`1 to ${FEDERATION_SHORT_NAME_MAX_LENGTH} characters`}
        </span>
      </span>
    );
  }

  const short = federationShortNameLength(props.label) <= FEDERATION_SHORT_NAME_KEEP_LENGTH;
  return (
    <span className="federation-short-name">
      <span className="federation-short-name__value">
        {props.shortLabel
          ? <>Short name <b>{props.shortLabel}</b></>
          : short
            ? "Short name same as the instance name"
            : "No short name yet; the full name shows"}
      </span>
      {props.shortLabel ? (
        <span className="settings-pill settings-pill--neutral">
          {props.source === "override" ? "Yours" : "Auto"}
        </span>
      ) : null}
      <button
        ref={renameRef}
        className="button button--ghost"
        type="button"
        aria-label={`Rename short name for ${props.label}`}
        disabled={!setter || saving}
        onClick={() => setDraft(props.shortLabel ?? "")}
      >
        Rename
      </button>
      {props.source === "override" ? (
        <button
          className="button button--ghost"
          type="button"
          aria-label={`Use the automatic short name for ${props.label}`}
          disabled={!setter || saving}
          onClick={() => apply(null)}
        >
          Use automatic
        </button>
      ) : null}
    </span>
  );
}
