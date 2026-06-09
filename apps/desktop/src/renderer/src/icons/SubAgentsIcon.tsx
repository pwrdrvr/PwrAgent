import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Sub-agents: a parent node delegating to two child nodes (a small
 * org chart). Reads as "tasks spun off from this thread."
 */
export function SubAgentsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
      <path d="M12 7.5v3.5" />
      <path d="M5.5 16v-1a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
