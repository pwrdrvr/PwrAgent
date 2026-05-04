import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Two-branch git glyph used for the "worktree" linked-directory kind —
 * distinct from BranchIcon (single-branch) so the two read at a glance.
 */
export function WorktreeIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="12" cy="19" r="2.5" />
      <path d="M6 7.5v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3" />
      <line x1="12" y1="13.5" x2="12" y2="16.5" />
    </svg>
  );
}
