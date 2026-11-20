import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** An archive box: the head of the card that stands in for an archived thread's composer. */
export const ArchiveIcon = memo(function ArchiveIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
});
