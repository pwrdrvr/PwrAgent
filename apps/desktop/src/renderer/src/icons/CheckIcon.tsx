import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const CheckIcon = memo(function CheckIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
});
