import { resolveIconSvgProps, type IconProps } from "./icon-types";

export function PlayIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M6 3 20 12 6 21z" />
    </svg>
  );
}
