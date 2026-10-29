import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Two opposing arrows — tools the agent calls, and that answer back. */
export const ConnectionsIcon = memo(function ConnectionsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H4" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  );
});
