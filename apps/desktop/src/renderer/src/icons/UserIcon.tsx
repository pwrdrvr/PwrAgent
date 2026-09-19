import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Head and shoulders — something that belongs to the operator personally. */
export const UserIcon = memo(function UserIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
});
