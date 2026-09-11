import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A commit on its history line — the glyph Git hosts use for a single commit,
 * drawn to sit beside `BranchIcon` at the same weight so a provenance row
 * reads as one vocabulary.
 */
export function CommitIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="3.5" />
      <line x1="2" y1="12" x2="8.5" y2="12" />
      <line x1="15.5" y1="12" x2="22" y2="12" />
    </svg>
  );
}
