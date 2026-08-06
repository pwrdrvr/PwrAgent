import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Star Map toggle glyph: a small body with an orbit line crossing it
 * and a satellite dot on the orbit. Stroke icon (not part of the
 * filled celestial set) so it matches the other chrome glyphs at
 * header-button sizes.
 */
export function StarMapIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <g transform="rotate(-20 12 12)">
        <ellipse cx="12" cy="12" rx="9.5" ry="4" />
        <circle cx="21.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      </g>
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
