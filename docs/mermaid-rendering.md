# Transcript Mermaid rendering

`ThreadMarkdown` renders code fences with the `mermaid` language as diagrams.
Unlabelled fences and other languages retain their normal code rendering.

## Loading and cost

- `MermaidDiagram` is small and contains no static Mermaid import.
- An IntersectionObserver waits until the diagram enters the viewport.
- After 300 ms without a source change, it dynamically imports `mermaid-runtime`.
- Mermaid 11.16.1 then imports the requested diagram type and layout code.
- Rendering is serialized because Mermaid owns global configuration and temporary DOM.
  Cancelled queued work is skipped; work already inside Mermaid finishes and its result
  is discarded if the component has changed or unmounted.
- Successful SVG layouts use a memory-only LRU cache: at most 32 entries and four million
  source/output characters (approximately 8 MB of UTF-16 character storage, excluding
  object overhead). Individual cached images are limited to one million characters.
- Parsing and layout still run on the renderer thread. The 20,000-character and
  200-edge limits bound accepted input; they are not a guarantee of a particular
  render time for every diagram type. There are no SQLite writes.

A local production Vite harness in headless Chromium 153 on macOS measured the
reported 10-node E2E flowchart at 15.8 ms to import the runtime and 47.7 ms for its
first render, including diagram/layout imports. A cache hit was below the timer's
resolution. These are single-run observations, exclude the intentional 300 ms
settling delay, and are not Electron startup measurements. They measure SVG layout
only, before the PNG conversion added for high-resolution clipboard copying.

The desktop production build's runtime chunk is approximately 624 KB minified
(uncompressed). The flowchart and layout chunks add approximately 140 KB.
They ship locally; no CDN or rendering service is contacted. Other diagram types
add their own code when used. Browser verification of a normal Markdown message
observed no Mermaid requests.

Math rendering has different behavior: `ThreadMarkdown` requests its KaTeX runtime
only when math rendering is enabled and a message contains potential math.
Mermaid rendering does not change that setting or its loading behavior.

## Rendering boundaries

Mermaid uses strict security, disabled HTML labels, and app theme colors. Its SVG
retains explicit dimensions from the viewBox and is rasterized to PNG, never
inserted as live transcript HTML. Its event-binding function is never called. The source remains copyable and
can be viewed with Show source. Clicking the image (or pressing Enter/Space) opens
the shared lightbox, with Zoom in and Fit to window controls. Both the preview and
lightbox use the PNG, so the existing native right-click Copy Image action copies
its full pixel resolution. The PNG uses 2x layout dimensions, capped at 8,192 pixels
on either axis and 16 million total pixels for large diagrams. Rasterization fills
the theme background so text remains legible when pasted into another app, and
releases the temporary canvas immediately. These limits cap its temporary RGBA
backing store at approximately 64 MB; mounted images also retain decoded pixels.

A stable Markdown pre component preserves the image and source toggle while prose
after a completed diagram streams. The preview scrolls at layout size instead of
shrinking wide diagrams. Parse failures retain source with a Diagram
unavailable label. A theme change regenerates the diagram for the new palette.

Front matter, initialization directives, custom style commands, image nodes, and
external-resource syntax fall back to source. These restrictions keep transcript
text from changing the renderer's security configuration or fetching resources
while Mermaid lays out temporary DOM. The temporary container is removed after
success or failure. This is a renderer for standard diagrams, not a Mermaid editor
with arbitrary configuration, external images, or clickable links.

## Dependencies and alternatives

The standard [Mermaid package](https://github.com/mermaid-js/mermaid) is MIT licensed.
Version 11.16.1 retains separate lazy diagram chunks and does not add the optional
ELK layout package. The [tiny build](https://mermaid.js.org/config/usage#tiny-mermaid)
reduces the total distribution but omits internal lazy loading and several
features. A CLI renderer would introduce a separate rendering process and lifecycle
for each request, while a hosted renderer would transmit transcript content.
The embedded standard package fits this Electron renderer and works offline.

`khroma@2.1.0` ships an MIT `license` file but omits its manifest license field.
`patches/khroma@2.1.0.patch` records that existing declaration in the manifest;
it does not change its license text. pnpm's license report uses pre-patch metadata,
so the shared notice/gate reader consults the matching installed manifest only
when pnpm reports Unknown. Its resulting SPDX identifier still passes through the
unchanged allowlist. The notice includes khroma's actual shipped license text.
