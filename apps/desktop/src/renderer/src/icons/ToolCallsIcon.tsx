import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Tool calls: command prompt with captured output lines. */
export function ToolCallsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <polyline points="4 6.5 7 9.5 4 12.5" />
      <line x1="10" y1="9.5" x2="14" y2="9.5" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <line x1="4" y1="19.5" x2="16" y2="19.5" />
    </svg>
  );
}
