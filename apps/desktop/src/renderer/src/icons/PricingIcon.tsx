import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Pricing: a banknote, for thread usage cost. Deliberately not a glyph in a
 * circle — at rail size a `$` in a circle read as the Thread info `i`.
 */
export const PricingIcon = memo(function PricingIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01" />
      <path d="M18 12h.01" />
    </svg>
  );
});
