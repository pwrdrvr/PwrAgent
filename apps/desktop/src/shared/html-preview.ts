/**
 * The `name` of the frame an HTML file preview renders in. The main process
 * blocks every subframe navigation; for this frame it also hands the URL to
 * the window, so the preview can offer the link instead of losing the click.
 */
export const HTML_PREVIEW_FRAME_NAME = "pwragent-html-preview";

/** Main → renderer: the preview frame tried to navigate to `url`. */
export const HTML_PREVIEW_NAVIGATION_CHANNEL = "html-preview:navigation";

export type HtmlPreviewNavigationEvent = {
  url: string;
};
