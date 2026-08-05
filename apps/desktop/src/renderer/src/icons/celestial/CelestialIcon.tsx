import type { CelestialIconId } from "@pwragent/shared";
import type { IconProps } from "../icon-types";
import { CelestialBlackHoleIcon } from "./CelestialBlackHoleIcon";
import { CelestialMoonIcon } from "./CelestialMoonIcon";
import { CelestialRingedPlanetIcon } from "./CelestialRingedPlanetIcon";
import { CelestialSunIcon } from "./CelestialSunIcon";
import { CelestialTiltedRingedPlanetIcon } from "./CelestialTiltedRingedPlanetIcon";

export type CelestialIconProps = { icon: CelestialIconId } & IconProps;

/**
 * Dispatch a celestial icon id to its component. Unknown ids render
 * nothing — the celestial contract requires renderers to treat future
 * ids as unassigned rather than crashing.
 */
export function CelestialIcon({ icon, ...props }: CelestialIconProps) {
  switch (icon) {
    case "sun":
      return <CelestialSunIcon {...props} />;
    case "moon":
      return <CelestialMoonIcon {...props} />;
    case "ringed-planet":
      return <CelestialRingedPlanetIcon {...props} />;
    case "tilted-ringed-planet":
      return <CelestialTiltedRingedPlanetIcon {...props} />;
    case "black-hole":
      return <CelestialBlackHoleIcon {...props} />;
    default:
      return null;
  }
}
