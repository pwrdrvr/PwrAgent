import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Generic terminal glyph (prompt + caret) used when we don't have an
 * OS-extracted icon for a terminal application. Same rationale as
 * EditorIcon — generic mark, not a specific terminal's brand.
 */
export function TerminalIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <polyline points="5 8 9 12 5 16" />
      <line x1="13" y1="16" x2="19" y2="16" />
    </svg>
  );
}
