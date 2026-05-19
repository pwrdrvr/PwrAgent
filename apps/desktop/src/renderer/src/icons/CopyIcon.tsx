import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Two overlapping rounded squares — the conventional "copy to clipboard"
 * glyph (matches the shape used by lucide, heroicons, etc.). Used in
 * place of the 📋 emoji that was previously the affordance on
 * ContextCopyButton; the emoji rendered with platform-color skin tones
 * + glossy gradient that clashed with the Tangerine Terminal palette
 * and didn't follow theme.
 */
export function CopyIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
