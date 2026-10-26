import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DesktopAppearanceDensity } from "@pwragent/shared";
import { PinIcon } from "../../icons";
import {
  setXrayPinned,
  useXrayMode,
  useXrayState,
  xrayKeyLabel,
} from "../../lib/xray-mode";

/**
 * Installs X-ray for the thread list (see lib/xray-mode.ts) and shows its
 * badge while it is on: a pill over the foot of the sidebar that names the
 * mode and carries the pin, as IntelliJ's X-Ray indicator does. The badge is
 * a portal measured against the sidebar's scroll region, so the sidebar's
 * own layout is untouched.
 */
export function XrayMode(props: {
  density: DesktopAppearanceDensity;
  /** X-ray only means something while the thread list is on screen. */
  enabled: boolean;
  platform: string | undefined;
}) {
  useXrayMode({
    enabled: props.enabled && props.density !== "mission-control",
    platform: props.platform,
  });
  const xray = useXrayState();
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number }>();

  useLayoutEffect(() => {
    if (!xray.active) {
      setAnchor(undefined);
      return;
    }
    const region = document.querySelector(".sidebar__scroll-region")
      ?? document.querySelector(".sidebar");
    if (!region) return;
    // A pinned badge outlives sidebar and window resizes; follow them.
    const measure = (): void => {
      const rect = region.getBoundingClientRect();
      const next = {
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.bottom,
      };
      setAnchor((current) =>
        current
        && current.left === next.left
        && current.width === next.width
        && current.bottom === next.bottom
          ? current
          : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(measure);
    observer?.observe(region);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [xray.active]);

  if (!xray.active || !anchor) return null;
  const key = xrayKeyLabel(props.platform);
  return createPortal(
    <div
      className="xray-badge"
      style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom + 12 }}
    >
      <span className="xray-badge__pill">
        {/* The live region holds the words only, not the pin's name. */}
        <span className="xray-badge__status" role="status">
          <span className="xray-badge__label">X-ray</span>
          <span className="xray-badge__hint">
            {xray.pinned ? `Pinned · press ${key} twice to unpin` : `Release ${key} to hide`}
          </span>
        </span>
        <button
          type="button"
          aria-pressed={xray.pinned}
          aria-label={xray.pinned ? "Unpin X-ray" : "Pin X-ray"}
          className={`xray-badge__pin${xray.pinned ? " is-pinned" : ""}`}
          onClick={() => setXrayPinned(!xray.pinned)}
        >
          <PinIcon size={12} aria-hidden="true" />
        </button>
      </span>
    </div>,
    document.body,
  );
}
