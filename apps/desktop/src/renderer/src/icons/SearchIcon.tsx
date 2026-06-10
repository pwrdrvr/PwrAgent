import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function SearchIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
