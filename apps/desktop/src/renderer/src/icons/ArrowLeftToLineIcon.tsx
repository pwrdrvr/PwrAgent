import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** An arrow into a bar on the left: send this back to the main column. */
export const ArrowLeftToLineIcon = memo(function ArrowLeftToLineIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3 19V5" />
      <path d="m13 6-6 6 6 6" />
      <path d="M7 12h14" />
    </svg>
  );
});
