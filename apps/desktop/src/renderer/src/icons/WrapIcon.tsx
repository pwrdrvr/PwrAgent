import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Text wrapping: a full line, a line that bends back under itself, and a
 * short line. The Logs window's Wrap toggle.
 */
export const WrapIcon = memo(function WrapIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3 6h18" />
      <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
      <path d="m16 16-2 2 2 2" />
      <path d="M3 18h7" />
    </svg>
  );
});
