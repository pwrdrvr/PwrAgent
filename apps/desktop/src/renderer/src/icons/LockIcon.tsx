import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Padlock glyph for a locked thread: the sidebar marker beside the title
 * and the head of the lock card over the thread view.
 */
export const LockIcon = memo(function LockIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
});
