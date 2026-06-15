import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function LightningIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </svg>
  );
}
