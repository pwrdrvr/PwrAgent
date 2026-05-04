import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Stacked-folders glyph for the "workspace" directory kind — multiple
 * directories grouped into a single composite working set.
 */
export function WorkspaceIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M22 17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.81 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2z" />
      <path d="M6 6V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.81 1.2a2 2 0 0 0 1.66.9H20" />
    </svg>
  );
}
