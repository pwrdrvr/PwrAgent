import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Pushpin glyph for the "pinned" thread marker. Replaces the literal
 * "Pinned" pill with a compact icon so the orange accent + the shape
 * carry the signal without spending a word's worth of row width.
 */
export function PinIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M9 4v6l-2 4v2h10v-2l-2-4V4" />
      <line x1="8" y1="4" x2="16" y2="4" />
      <line x1="12" y1="16" x2="12" y2="21" />
    </svg>
  );
}
