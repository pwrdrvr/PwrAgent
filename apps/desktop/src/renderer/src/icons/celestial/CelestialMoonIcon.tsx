import { resolveFilledIconSvgProps, type IconProps } from "../icon-types";

/**
 * Cratered moon: one large filled disc with three craters. The disc
 * path punches the craters out via `fill-rule="evenodd"` so the crater
 * circles underneath it can re-fill them at reduced opacity — depth
 * from opacity layering only, no second color.
 */
export function CelestialMoonIcon(props: IconProps) {
  return (
    <svg {...resolveFilledIconSvgProps(props)}>
      <g fill="currentColor" fillOpacity="0.35">
        <circle cx="9" cy="9" r="2" />
        <circle cx="15.5" cy="12.5" r="1.5" />
        <circle cx="10.5" cy="16" r="1.5" />
      </g>
      <path
        fill="currentColor"
        fillOpacity="0.9"
        fillRule="evenodd"
        d={
          "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z"
          + "M9 7a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z"
          + "M15.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3Z"
          + "M10.5 14.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3Z"
        }
      />
    </svg>
  );
}
