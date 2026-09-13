import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const PlusIcon = memo(function PlusIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
});
