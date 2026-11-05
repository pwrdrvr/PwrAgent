import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Lucide `maximize-2`: bring a toast back into its dialog. */
export const ExpandIcon = memo(function ExpandIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </svg>
  );
});
