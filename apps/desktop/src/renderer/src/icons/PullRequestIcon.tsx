import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Git pull-request glyph: a branch line joining a target circle. */
export function PullRequestIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 15.5V11a2 2 0 0 0-2-2h-3" />
      <path d="M15.5 6.5 13 9l2.5 2.5" />
    </svg>
  );
}
