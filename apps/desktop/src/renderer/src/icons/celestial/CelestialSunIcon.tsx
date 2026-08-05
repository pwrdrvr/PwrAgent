import { resolveFilledIconSvgProps, type IconProps } from "../icon-types";

const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/**
 * Shining sun: filled central disc plus eight rays. The gateway
 * instance's celestial mark — it reads as the hub of the star map.
 */
export function CelestialSunIcon(props: IconProps) {
  return (
    <svg {...resolveFilledIconSvgProps(props)}>
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {RAY_ANGLES.map((angle) => (
          <line
            key={angle}
            x1="12"
            y1="2"
            x2="12"
            y2="5"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}
