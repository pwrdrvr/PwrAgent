import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** An arrow into a bar on the right: send this to the right-hand rail. */
export const ArrowRightToLineIcon = memo(function ArrowRightToLineIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M17 12H3" />
      <path d="m11 18 6-6-6-6" />
      <path d="M21 5v14" />
    </svg>
  );
});
