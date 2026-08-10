import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A pencil poised over a baseline — text written but not sent. Deliberately
 * unlike `EditsIcon` (a document with change marks, which is about files an
 * agent touched) so a row carrying both never reads as one repeated glyph.
 */
export function DraftIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4z" />
      <path d="M4 21h16" />
    </svg>
  );
}
