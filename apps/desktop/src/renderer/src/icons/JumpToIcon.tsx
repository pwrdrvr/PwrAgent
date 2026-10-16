import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const JumpToIcon = memo(function JumpToIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
});
