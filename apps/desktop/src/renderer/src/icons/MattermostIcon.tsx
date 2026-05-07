import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Mattermost wordmark glyph rendered as a monochrome silhouette filled
 * with `currentColor` so it picks up the same accent treatment as the
 * Telegram and Discord icons. Avoids the brand blues that would clash
 * with the Tangerine Terminal theme.
 */
export function MattermostIcon(props: IconProps) {
  const svgProps = resolveIconSvgProps(props);
  return (
    <svg {...svgProps} fill="currentColor" stroke="none">
      <path d="M12 2.4c-5.3 0-9.6 4.3-9.6 9.6 0 2.86 1.25 5.42 3.23 7.18l.74-2.73a7.06 7.06 0 0 1 5.88-11l3.07.4-1.28 2.43A4.6 4.6 0 0 0 7.4 12a4.6 4.6 0 0 0 9.2 0c0-1.36-.59-2.58-1.53-3.42l1.05-2.78A9.6 9.6 0 0 1 21.6 12c0 2.96-1.34 5.61-3.45 7.37l-.7-2.7c.96-1.27 1.55-2.86 1.55-4.6a7.04 7.04 0 0 0-1.27-4.05l-.96 2.55c.13.48.21.99.21 1.5a4.98 4.98 0 0 1-9.96 0c0-1.05.33-2.02.88-2.83l1.27 4.7L12 12 7.97 7.96l1.34-2.55A6.96 6.96 0 0 1 12 4.94c.41 0 .81.03 1.2.1l1.78 5.94L17 6.62A9.55 9.55 0 0 0 12 2.4z" />
    </svg>
  );
}
