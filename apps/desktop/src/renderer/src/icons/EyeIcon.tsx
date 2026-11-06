import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * An open eye: something is watching on this thread's behalf and will wake
 * it. One object, no pupil highlight, so it still reads at 12px.
 */
export const EyeIcon = memo(function EyeIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
});
