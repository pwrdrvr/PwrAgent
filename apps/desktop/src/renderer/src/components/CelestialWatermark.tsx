import type { CelestialIconId } from "@pwragent/shared";
import { CelestialIcon } from "../icons";

/**
 * Low-opacity celestial identity mark rendered behind thread content. The
 * icon identifies the owning instance ("the moon machine"); opacity lives in
 * the `.celestial-watermark` rule so the a11y contrast gate audits one place.
 */
export function CelestialWatermark(props: { icon?: CelestialIconId }) {
  if (!props.icon) return null;
  return (
    <div className="celestial-watermark" aria-hidden="true">
      <CelestialIcon icon={props.icon} size={288} />
    </div>
  );
}
