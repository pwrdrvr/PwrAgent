import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A circle struck through: something deliberately set aside. */
export const BanIcon = memo(function BanIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="m6.5 6.5 11 11" />
    </svg>
  );
});
