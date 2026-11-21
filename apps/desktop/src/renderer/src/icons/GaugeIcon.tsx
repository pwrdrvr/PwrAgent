import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A gauge: how much of a limit is used. The AI provider tab shows accounts,
 * rate limits, and usage pace; `ServerIcon` means a machine elsewhere.
 */
export const GaugeIcon = memo(function GaugeIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3.5 18.5a9.5 9.5 0 1 1 17 0" />
      <path d="M12 15l4-5" />
      <circle cx="12" cy="15" r="1.25" />
      <path d="M6.5 12.5h.01" />
      <path d="M8.5 8.5h.01" />
      <path d="M12 7h.01" />
    </svg>
  );
});
