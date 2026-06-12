import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
