import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** MicIcon with a slash: the microphone is muted. */
export const MicOffIcon = memo(function MicOffIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      <path d="M3 3l18 18" />
    </svg>
  );
});
