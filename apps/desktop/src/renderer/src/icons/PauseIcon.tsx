import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const PauseIcon = memo(function PauseIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </svg>
  );
});
