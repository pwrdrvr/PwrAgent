import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A thread: a conversation bubble with two transcript lines. Marks a
 * reference to another thread (see `ThreadChip`), where `NewThreadIcon`
 * would wrongly read as "create" and `SubAgentsIcon` as "delegated work".
 */
export function ThreadIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M20 14a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M8 8.5h8" />
      <path d="M8 12h5" />
    </svg>
  );
}
