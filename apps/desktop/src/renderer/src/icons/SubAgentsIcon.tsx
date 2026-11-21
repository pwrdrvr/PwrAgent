import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Sub-agents: a parent agent dispatching two child agents, drawn as square
 * nodes so it never reads as the pull-request glyph's round commit nodes.
 */
export const SubAgentsIcon = memo(function SubAgentsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="8.5" y="2.5" width="7" height="6" rx="1.5" />
      <rect x="2.5" y="15.5" width="7" height="6" rx="1.5" />
      <rect x="14.5" y="15.5" width="7" height="6" rx="1.5" />
      <path d="M12 8.5v3.5" />
      <path d="M6 15.5V14a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1.5" />
    </svg>
  );
});
