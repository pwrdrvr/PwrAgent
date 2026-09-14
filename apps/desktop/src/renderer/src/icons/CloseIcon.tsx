import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const CloseIcon = memo(function CloseIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
});
