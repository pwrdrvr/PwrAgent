import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A two-prong plug — something a plugin installed. */
export const PlugIcon = memo(function PlugIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
});
