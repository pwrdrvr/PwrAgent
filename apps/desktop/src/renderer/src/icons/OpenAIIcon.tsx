import { memo, type ImgHTMLAttributes } from "react";
import { useBrandTheme } from "./brand-theme";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import blossomBlackUrl from "../assets/openai/OAI_OpenAI-Blossom_Black.svg";
import blossomWhiteUrl from "../assets/openai/OAI_OpenAI-Blossom_White.svg";

/**
 * Official OpenAI Blossom from OpenAI's logo pack
 * (https://openai.com/brand/). OpenAI publishes no separate Codex mark, so
 * the Blossom identifies the Codex CLI. It ships in black and white only and
 * must not be recolored, so this picks between those two files — black on
 * the light theme, white on dark.
 *
 * The files carry OpenAI's own clear space: the mark covers about half of
 * the canvas. Size the `<img>` to the box the mark and its clear space
 * should occupy; never crop it. See `assets/openai/README.md`.
 */
const VARIANT_URL: Record<OpenAIIconVariant, string> = {
  black: blossomBlackUrl,
  white: blossomWhiteUrl,
};

export type OpenAIIconVariant = "black" | "white";

export type OpenAIIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: OpenAIIconVariant;
};

export const OpenAIIcon = memo(function OpenAIIcon({
  size = DEFAULT_ICON_SIZE,
  variant,
  alt = "",
  ...rest
}: OpenAIIconProps) {
  const theme = useBrandTheme(!variant);
  const resolved = variant ?? (theme === "light" ? "black" : "white");
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
