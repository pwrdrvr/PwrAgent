import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}
