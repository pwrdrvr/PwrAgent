import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const ChevronUpIcon = memo(function ChevronUpIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
});
