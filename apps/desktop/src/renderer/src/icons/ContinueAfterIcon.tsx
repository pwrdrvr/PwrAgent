import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Two threads joined by an elbow: this one continues after that one. */
export const ContinueAfterIcon = memo(function ContinueAfterIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V12a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
});
