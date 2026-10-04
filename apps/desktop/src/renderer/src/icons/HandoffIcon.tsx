import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const HandoffIcon = memo(function HandoffIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m15 17 5-5-5-5" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </svg>
  );
});
