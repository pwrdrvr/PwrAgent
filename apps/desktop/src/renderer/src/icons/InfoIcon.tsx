import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function InfoIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}
