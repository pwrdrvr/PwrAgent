import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Add-reaction trigger glyph — a stroke-based smiley that matches the
 * rest of the icon set (currentColor, 1.75 stroke). Used by the
 * thread-row "add reaction" chip on hover. The previous emoji 🙂
 * brought a yellow OS-rendered face that fought the dark theme — this
 * version inherits the chip's foreground color.
 */
export function SmileyIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <path d="M8.5 14.5c1 1.4 2.2 2.1 3.5 2.1s2.5-.7 3.5-2.1" />
    </svg>
  );
}
