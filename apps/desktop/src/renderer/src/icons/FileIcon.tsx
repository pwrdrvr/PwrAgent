import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A plain document: a file reference that opens in the preview. */
export const FileIcon = memo(function FileIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
});
