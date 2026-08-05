import { resolveFilledIconSvgProps, type IconProps } from "../icon-types";

/**
 * Saturn-like ringed planet at a gentle tilt. The ring is split into
 * two elliptical arcs so it reads three-dimensionally: the far (upper)
 * half sits behind the disc at reduced opacity, the near (lower) half
 * paints after the disc and crosses in front of it.
 */
export function CelestialRingedPlanetIcon(props: IconProps) {
  return (
    <svg {...resolveFilledIconSvgProps(props)}>
      <g transform="rotate(-20 12 12)">
        <path
          d="M1.5 12A10.5 3.5 0 0 1 22.5 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.45"
        />
        <circle cx="12" cy="12" r="6.5" fill="currentColor" fillOpacity="0.85" />
        <path
          d="M1.5 12A10.5 3.5 0 0 0 22.5 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
