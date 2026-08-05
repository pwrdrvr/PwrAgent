import { resolveFilledIconSvgProps, type IconProps } from "../icon-types";

/**
 * Black hole: a fully opaque sphere with a thin accretion ring
 * crossing in front of it, plus a fainter arc above the sphere
 * suggesting the gravitationally lensed far side of the ring.
 * Original geometry — shape language only.
 */
export function CelestialBlackHoleIcon(props: IconProps) {
  return (
    <svg {...resolveFilledIconSvgProps(props)}>
      <circle cx="12" cy="12.5" r="6" fill="currentColor" />
      <ellipse
        cx="12"
        cy="12.5"
        rx="10.5"
        ry="2.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        opacity="0.9"
      />
      <path
        d="M5.25 12.5A6.75 6.75 0 0 1 18.75 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}
