import { memo, type ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
// The full-bleed master, not a copy: the padded macOS variants are the wrong
// mark outside macOS, and a renderer copy would drift from the shipped icon.
import pwragentAppIconUrl from "../../../../build/icon.png";

export type PwrAgentIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
};

/**
 * PwrAgent's own application icon, for surfaces that draw PwrAgent beside
 * another product's mark (the onboarding wizard's PwrAgent ↔ Codex
 * diagrams). Rendered as an `<img>` like the vendor marks it sits next to,
 * so both sides of a pairing size and align the same way.
 */
export const PwrAgentIcon = memo(function PwrAgentIcon({
  size = DEFAULT_ICON_SIZE,
  alt = "",
  ...rest
}: PwrAgentIconProps) {
  return (
    <img
      src={pwragentAppIconUrl}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
});
