import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const ResearchIcon = memo(function ResearchIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M9 3h6M10 3v6l-5.5 9a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3" />
      <path d="M7 14h10" />
      <circle cx="10" cy="17" r="0.7" />
      <circle cx="14" cy="18" r="0.7" />
    </svg>
  );
});
