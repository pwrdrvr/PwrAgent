import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Skills ($ mentions). An open-jaw wrench: jaw at the top right, handle
 * running to the bottom left.
 *
 * It is one tool on purpose. The obvious mark for "skills" is a crossed
 * wrench + screwdriver, and that version is legible at 24px and up — but
 * this icon ships at 12px in `SkillChip` and would be 13px in a picker
 * row, and at that size two crossed diagonals with small heads stop
 * reading as tools and start reading as scissors. Every other icon in
 * this library is a single object for the same reason. If you revisit
 * this, render it at 12–13px before trusting how it looks in a design
 * tool.
 */
export function SkillIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M15.6 4.4A3.6 3.6 0 1 0 19.6 8.4" />
      <path d="M13.6 10.4 5.2 18.8" />
    </svg>
  );
}
