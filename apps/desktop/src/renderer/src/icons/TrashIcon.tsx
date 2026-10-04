import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A lidded bin — the conventional "delete" glyph (lucide's `trash-2`
 * shape without the inner strokes, which blur at 14px). Used for row-level
 * Delete actions that sit in too little room for a text label.
 */
export const TrashIcon = memo(function TrashIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
    </svg>
  );
});
