import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Pricing: dollar mark for thread usage accounting. */
export function PricingIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.75v10.5" />
      <path d="M15.5 8.75H10.8a2.05 2.05 0 0 0 0 4.1h2.4a2.05 2.05 0 0 1 0 4.1H8.5" />
    </svg>
  );
}
