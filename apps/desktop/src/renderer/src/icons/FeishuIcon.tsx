import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import larkBrandIconUrl from "../assets/feishu/lark.svg";

export type FeishuIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
};

export function FeishuIcon({
  size = DEFAULT_ICON_SIZE,
  alt = "",
  ...rest
}: FeishuIconProps) {
  return (
    <img
      src={larkBrandIconUrl}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
