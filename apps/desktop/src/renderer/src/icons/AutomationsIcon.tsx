import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Calendar grid — matches the automations glyph used in the title bar. */
export function AutomationsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    </svg>
  );
}
