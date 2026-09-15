import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Four corner brackets — "size the content to the frame". Distinct from
 *  `PopoutIcon`'s out-of-frame arrow, which means "open elsewhere". */
export const FitToWindowIcon = memo(function FitToWindowIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M4 9V6a2 2 0 0 1 2-2h3" />
      <path d="M15 4h3a2 2 0 0 1 2 2v3" />
      <path d="M20 15v3a2 2 0 0 1-2 2h-3" />
      <path d="M9 20H6a2 2 0 0 1-2-2v-3" />
    </svg>
  );
});
