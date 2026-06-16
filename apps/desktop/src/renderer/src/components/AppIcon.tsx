import { useState } from "react";
import type { DesktopApplicationDiscoveryCandidate } from "@pwragent/shared";
import { EditorIcon, TerminalIcon } from "../icons";

/**
 * Renders an installed application's real OS icon and centralizes the
 * fallback chain every app-icon surface needs: the icon extracted in the
 * main process via `app.getFileIcon` (delivered as `iconDataUrl`), then a
 * kind glyph (editor / terminal), then the application's initial.
 *
 * Used by the composer launcher buttons, the Settings → Applications rows,
 * and the edited-file "open in editor" affordance so the same resolution
 * isn't reimplemented per surface. `className` is applied to whichever
 * element renders and `size` sizes both the `<img>` and the glyph. If the
 * data URL ever fails to decode in the browser, `onError` drops to the glyph
 * fallback rather than showing a broken image.
 */
export function AppIcon(props: {
  application: DesktopApplicationDiscoveryCandidate;
  size?: number;
  className?: string;
}) {
  const size = props.size ?? 18;
  const { application, className } = props;
  // Track the specific src that failed, so swapping to a different app (new
  // iconDataUrl) re-attempts the image instead of staying on the fallback.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);

  if (application.iconDataUrl && failedSrc !== application.iconDataUrl) {
    return (
      <img
        alt=""
        className={className}
        height={size}
        src={application.iconDataUrl}
        width={size}
        onError={() => setFailedSrc(application.iconDataUrl)}
      />
    );
  }

  if (application.kind === "editor") {
    return <EditorIcon aria-hidden className={className} size={size} />;
  }
  if (application.kind === "terminal") {
    return <TerminalIcon aria-hidden className={className} size={size} />;
  }

  return (
    <span aria-hidden="true" className={className}>
      {application.name.slice(0, 1)}
    </span>
  );
}
