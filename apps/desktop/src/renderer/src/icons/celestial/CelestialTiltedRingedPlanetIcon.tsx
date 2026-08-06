import { resolveFilledIconSvgProps, type IconProps } from "../icon-types";

/**
 * Second ringed planet with a deliberately different silhouette from
 * `CelestialRingedPlanetIcon`: the ring stands near-vertical (~65°),
 * the disc is smaller, and the ring is thicker. Same arc split as the
 * gentle-tilt planet — far half dimmed behind the disc, near half
 * crossing in front.
 */
export function CelestialTiltedRingedPlanetIcon(props: IconProps) {
  return (
    <svg {...resolveFilledIconSvgProps(props)}>
      <g transform="rotate(-65 12 12)">
        <path
          d="M2 12A10 3.25 0 0 1 22 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.45"
        />
        <circle cx="12" cy="12" r="5.5" fill="currentColor" fillOpacity="0.85" />
        <path
          d="M2 12A10 3.25 0 0 0 22 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
