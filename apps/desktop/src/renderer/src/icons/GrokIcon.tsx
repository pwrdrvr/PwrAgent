import { memo, type ImgHTMLAttributes } from "react";
import { useBrandTheme } from "./brand-theme";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import logomarkDarkUrl from "../assets/grok/Grok_Logomark_Dark.svg";
import logomarkLightUrl from "../assets/grok/Grok_Logomark_Light.svg";

/**
 * Official Grok logomark from SpaceXAI's (formerly xAI) logo download
 * (https://x.ai/legal/brand-guidelines). xAI asks for its logos "exactly as
 * provided", so this picks between the two published colorways rather than
 * recoloring one. xAI names a file for the mark's color: `Dark` is the
 * near-black mark for light surfaces, `Light` the white mark for dark ones.
 *
 * Unlike the OpenAI Blossom, the file has no built-in clear space — the mark
 * runs to the edges of its canvas. See `assets/grok/README.md`.
 */
const VARIANT_URL: Record<GrokIconVariant, string> = {
  dark: logomarkDarkUrl,
  light: logomarkLightUrl,
};

export type GrokIconVariant = "dark" | "light";

export type GrokIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: GrokIconVariant;
};

export const GrokIcon = memo(function GrokIcon({
  size = DEFAULT_ICON_SIZE,
  variant,
  alt = "",
  ...rest
}: GrokIconProps) {
  const theme = useBrandTheme(!variant);
  const resolved = variant ?? (theme === "light" ? "dark" : "light");
  return (
    <img
      src={VARIANT_URL[resolved]}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
});
