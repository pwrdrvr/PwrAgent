import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Pricing: compact receipt/cost mark for thread usage accounting. */
export function PricingIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M7 3h10a2 2 0 0 1 2 2v16l-3-1.5L13 21l-3-1.5L7 21V5a2 2 0 0 1 2-2Z" />
      <path d="M9.5 8h5" />
      <path d="M9.5 12h5" />
      <path d="M15.5 16h-1.75a1.75 1.75 0 0 1 0-3.5h.5a1.75 1.75 0 0 0 0-3.5H12.5" />
      <path d="M14 7.75v1.25" />
      <path d="M14 16v1.25" />
    </svg>
  );
}
