import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function ChevronUpIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}
