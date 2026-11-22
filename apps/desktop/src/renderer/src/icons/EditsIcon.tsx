import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Edited-files glyph: a document with a plus over a minus (a file diff). */
export const EditsIcon = memo(function EditsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 9.5v5" />
      <path d="M9.5 12h5" />
      <path d="M9.5 17.5h5" />
    </svg>
  );
});
