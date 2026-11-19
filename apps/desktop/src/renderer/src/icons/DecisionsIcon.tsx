import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Decisions: a balance scale with two pans. */
export const DecisionsIcon = memo(function DecisionsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="8" y1="20" x2="16" y2="20" />
      <line x1="5" y1="7" x2="19" y2="7" />
      <path d="M5 7 2.5 13a2.5 2.5 0 0 0 5 0Z" />
      <path d="M19 7 16.5 13a2.5 2.5 0 0 0 5 0Z" />
    </svg>
  );
});
