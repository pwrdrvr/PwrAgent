import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A line that drops and turns right — this thread hangs off another one.
 * Marks a sub-thread's parent where the two are not drawn together: the
 * composer's source row and a draft row filed away from its parent.
 */
export const SubthreadIcon = memo(function SubthreadIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M5 4v7a4 4 0 0 0 4 4h11" />
      <path d="m15 10 5 5-5 5" />
    </svg>
  );
});
