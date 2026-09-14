import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const PlayIcon = memo(function PlayIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M6 3 20 12 6 21z" />
    </svg>
  );
});
