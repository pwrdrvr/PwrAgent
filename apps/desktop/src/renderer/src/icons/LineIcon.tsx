import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import lineBrandIconUrl from "../assets/line/LINE_Brand_icon.png";

export type LineIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
};

export function LineIcon({
  size = DEFAULT_ICON_SIZE,
  alt = "",
  ...rest
}: LineIconProps) {
  return (
    <img
      src={lineBrandIconUrl}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
