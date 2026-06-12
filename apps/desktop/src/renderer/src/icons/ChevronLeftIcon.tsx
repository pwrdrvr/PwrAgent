import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
