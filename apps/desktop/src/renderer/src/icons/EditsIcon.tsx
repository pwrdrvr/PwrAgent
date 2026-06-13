import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Edited-files glyph: a document with +/- change marks. */
export function EditsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9.5 12.5h3" />
      <path d="M11 11v3" />
      <path d="M9.5 17h3" />
    </svg>
  );
}
