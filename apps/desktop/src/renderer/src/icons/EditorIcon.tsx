import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Generic editor glyph (curly braces) used when we don't have an
 * OS-extracted icon for an editor application. We intentionally avoid
 * replicating any specific editor's brand mark — distribution licensing
 * for third-party logos is fraught, and the Tangerine Terminal thesis
 * is monochrome anyway.
 */
export function EditorIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M9 4H7.5a2.5 2.5 0 0 0-2.5 2.5v3a2.5 2.5 0 0 1-2 2.45 2.5 2.5 0 0 1 2 2.45v3A2.5 2.5 0 0 0 7.5 20H9" />
      <path d="M15 4h1.5a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 0 2 2.45 2.5 2.5 0 0 0-2 2.45v3a2.5 2.5 0 0 1-2.5 2.5H15" />
    </svg>
  );
}
