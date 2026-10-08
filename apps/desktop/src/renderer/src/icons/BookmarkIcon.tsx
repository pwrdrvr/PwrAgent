import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A ribbon bookmark. The Logs window's Mark, a divider dropped in the view. */
export const BookmarkIcon = memo(function BookmarkIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  );
});
