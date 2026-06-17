import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function HelpCircleIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 1.6-1.6 2.1-2.1 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}
