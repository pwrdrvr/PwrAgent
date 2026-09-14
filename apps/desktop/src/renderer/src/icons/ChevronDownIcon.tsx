import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const ChevronDownIcon = memo(function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
});
