import { useRef, useState } from "react";
import {
  readRendererFederationLabel,
  readRendererFederationTarget,
} from "../../lib/federation-window";
import { copyText } from "../../lib/copy-text";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * "Remote · <machine>" identity marker for federation windows. Rendered
 * as a sidebar identity pill (profile-style) while the sidebar is open,
 * and as a compact title-bar badge when the sidebar is the surface that
 * got hidden — the window must always carry a visible remote marker.
 * The label truncates, so the viewport tooltip spells out the full
 * machine name + instance id; clicking copies the instance id.
 */
export function FederationRemoteBadge(props: {
  className?: string;
  textClassName?: string;
}) {
  const label = readRendererFederationLabel();
  const target = readRendererFederationTarget();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  if (!label && !target) {
    return null;
  }
  const display = label ?? target?.instanceId ?? "";
  const tooltipText = copied
    ? "Copied instance id"
    : target
      ? `${display} · ${target.instanceId}\nClick to copy the instance id`
      : display;

  return (
    <>
      <button
        aria-label={`Remote instance: ${display}. Copy instance id.`}
        className={props.className ?? "federation-remote-badge"}
        type="button"
        onBlur={() => {
          tooltip.hide();
          setCopied(false);
        }}
        onClick={(event) => {
          if (!target) return;
          const anchor = event.currentTarget;
          void copyText(target.instanceId).then(() => {
            setCopied(true);
            tooltip.show(anchor, "Copied instance id");
            if (copiedTimerRef.current) {
              clearTimeout(copiedTimerRef.current);
            }
            copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <span className={props.textClassName ?? "federation-remote-badge__text"}>
          Remote · {display}
        </span>
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
