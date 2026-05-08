import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import symbolBlackUrl from "../assets/discord/symbol-black.svg";
import symbolBlurpleUrl from "../assets/discord/symbol-blurple.svg";
import symbolWhiteUrl from "../assets/discord/symbol-white.svg";

const VARIANT_URL: Record<DiscordIconVariant, string> = {
  black: symbolBlackUrl,
  blurple: symbolBlurpleUrl,
  white: symbolWhiteUrl,
};

export type DiscordIconVariant = "black" | "blurple" | "white";

export type DiscordIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: DiscordIconVariant;
};

/**
 * Official Discord Symbol asset from Discord's brand kit. Discord
 * permits white, black, and Blurple variants, but forbids recoloring
 * or reconfiguring the mark, so this renders the verbatim SVG via img.
 */
export function DiscordIcon({
  size = DEFAULT_ICON_SIZE,
  variant = "white",
  alt = "",
  ...rest
}: DiscordIconProps) {
  return (
    <img
      src={VARIANT_URL[variant]}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
