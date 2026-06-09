import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Pushpin. `filled` paints the head with `currentColor` to signal the
 * pinned/active state; the outline-only form reads as "click to pin".
 */
export function PinIcon({ filled, ...props }: IconProps & { filled?: boolean }) {
  const svgProps = resolveIconSvgProps(props);
  return (
    <svg {...svgProps}>
      <path
        d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M12 16v5" />
    </svg>
  );
}
