import type { ReadHtmlPreviewAssetsResponse } from "@pwragent/shared";

/**
 * Builds the `srcdoc` an HTML file preview renders.
 *
 * The page runs in an opaque-origin iframe with no network access. That is
 * enforced twice: every reference to the web is removed before the page is
 * written, and a Content-Security-Policy as the first element of its head
 * allows only `data:` and `blob:` URLs. Files beside the page are read by
 * the main process, which keeps them inside the page's folder, and are
 * inlined as `data:` URLs. Scripts are off unless the operator turns them
 * on; the sandbox attribute is what enforces that, and the policy repeats it.
 */

export type HtmlPreviewAssetReader = (
  refs: string[],
) => Promise<ReadHtmlPreviewAssetsResponse>;

export type HtmlPreviewResources = {
  /** Data URL for each local ref, keyed as the page wrote it. */
  assets: ReadonlyMap<string, string>;
  /** Text of each linked stylesheet, its own refs rebased onto the page. */
  stylesheets: ReadonlyMap<string, string>;
  /** Set when no local file could be read, such as for a peer's page. */
  unavailable?: string;
};

export type PreparedHtmlPreview = {
  /** The page behind the policy for one mode, without parsing it again. */
  srcdoc: (scripts: boolean) => string;
  /** Distinct web URLs the page asked for and did not get. */
  blockedRemote: number;
  /** Distinct local files the page asked for and did not get. */
  missingLocal: number;
};

const STATIC_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// Scripts may run, but still only from the page itself: `connect-src` keeps
// fetch, XHR, WebSocket and beacons inside the frame. No directive covers
// WebRTC. The window's preload removes it from this frame and from every frame
// the page nests (`src/preload/subframe-hardening.ts`). Trusted Types close
// the one way to a new document that preload never sees, a `javascript:`
// navigation: the preload's default policy passes every other string through.
const SCRIPT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

/**
 * Runs before the page's own scripts. History calls throw in an
 * opaque-origin srcdoc frame; single-page demos call them on load.
 */
const SCRIPT_GUARD = `(function () {
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name].bind(history);
    history[name] = function () {
      try {
        return original.apply(null, arguments);
      } catch (error) {
        if (!error || error.name !== "SecurityError") throw error;
      }
    };
  });
})();`;

/** Attributes that load a resource, and the elements they load on. */
const RESOURCE_ATTRIBUTES = ["src", "poster", "background", "data"] as const;
const RESOURCE_ATTRIBUTE_ELEMENTS: Partial<Record<string, ReadonlySet<string>>> = {
  background: new Set(["body", "table", "tr", "td", "th"]),
  data: new Set(["object"]),
};

/**
 * Where a link to a local file points inside the frame. A frame may not
 * navigate to `file:` at all, and then the click would be lost before the
 * main process could hand it back; this origin cannot resolve, and the main
 * process stops the navigation before it is requested.
 */
export const HTML_PREVIEW_LOCAL_LINK_ORIGIN = "https://local-file.pwragent.invalid";
const SRCSET_ATTRIBUTES = ["srcset", "imagesrcset"] as const;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const EMPTY_CSS_URL = 'url("data:,")';

type RefKind = "inline" | "fragment" | "remote" | "local" | "other";

/** What the page's ref points at. Inline URLs and fragments stay put. */
export function classifyHtmlPreviewRef(ref: string): RefKind {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#")) return "fragment";
  if (/^(?:data|blob):/i.test(trimmed)) return "inline";
  if (/^(?:https?:)?\/\//i.test(trimmed) || /^[/\\]{2}/.test(trimmed)) return "remote";
  if (/^file:/i.test(trimmed) || /^[a-z]:[/\\]/i.test(trimmed)) return "local";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "other";
  return "local";
}

/** Every local file the page loads directly, as written. */
export function collectHtmlPreviewRefs(html: string): string[] {
  const doc = parseHtml(html);
  const refs = new Set<string>();
  const add = (ref: string | null | undefined) => {
    if (ref && classifyHtmlPreviewRef(ref) === "local") refs.add(ref.trim());
  };
  for (const element of doc.querySelectorAll("*")) {
    if (isStylesheetLink(element)) {
      add(element.getAttribute("href"));
      continue;
    }
    for (const name of RESOURCE_ATTRIBUTES) {
      if (loadsResource(element, name)) add(element.getAttribute(name));
    }
    for (const name of SRCSET_ATTRIBUTES) {
      for (const candidate of parseSrcset(element.getAttribute(name) ?? "")) add(candidate.url);
    }
    if (element.namespaceURI === SVG_NAMESPACE && element.localName !== "a") {
      add(svgHref(element));
    }
    const style = element.getAttribute("style");
    if (style) for (const ref of cssRefs(style)) add(ref);
    if (element.localName === "style") {
      for (const ref of cssRefs(element.textContent ?? "")) add(ref);
    }
  }
  return [...refs];
}

/**
 * Read every local file the page uses. Linked stylesheets take a second
 * round, for the images and fonts they name relative to themselves.
 */
export async function resolveHtmlPreviewResources(
  html: string,
  readAssets: HtmlPreviewAssetReader | undefined,
  unavailableReason = "Files beside this page are not loaded here.",
): Promise<HtmlPreviewResources> {
  const refs = collectHtmlPreviewRefs(html);
  if (refs.length === 0) {
    return { assets: new Map(), stylesheets: new Map() };
  }
  if (!readAssets) {
    return { assets: new Map(), stylesheets: new Map(), unavailable: unavailableReason };
  }

  const assets = new Map<string, string>();
  const first = await readAssets(refs);
  if (first.error) {
    return { assets, stylesheets: new Map(), unavailable: first.error };
  }
  for (const asset of first.assets) assets.set(asset.ref, asset.dataUrl);

  const stylesheets = new Map<string, string>();
  const nested = new Set<string>();
  for (const [ref, dataUrl] of assets) {
    if (!dataUrl.startsWith("data:text/css")) continue;
    const css = decodeDataUrlText(dataUrl);
    if (css === undefined) continue;
    const rebased = rewriteCssUrls(css, (url) => {
      if (classifyHtmlPreviewRef(url) !== "local") return undefined;
      const target = rebaseRef(ref, url);
      if (!assets.has(target)) nested.add(target);
      return `url("${cssString(target)}")`;
    });
    stylesheets.set(ref, rebased);
  }
  if (nested.size > 0) {
    const second = await readAssets([...nested]);
    for (const asset of second.assets) assets.set(asset.ref, asset.dataUrl);
  }
  return { assets, stylesheets };
}

/**
 * Write the page with every load either inlined or removed, links pointed
 * where the viewer can catch them, and the policy in front of everything.
 *
 * `fileUrl` is the page's own `file:` URL, which relative links resolve
 * against. Leave it out for a page that lives on another machine: its
 * relative links name files this machine does not have.
 */
export function prepareHtmlPreviewDocument(
  html: string,
  resources: HtmlPreviewResources,
  options: { fileUrl?: string },
): PreparedHtmlPreview {
  const doc = parseHtml(html);
  const blocked = new Set<string>();
  const missing = new Set<string>();

  const inline = (ref: string): string | undefined => {
    const trimmed = ref.trim();
    switch (classifyHtmlPreviewRef(trimmed)) {
      case "inline":
      case "fragment":
        return ref;
      case "local": {
        const dataUrl = resources.assets.get(trimmed);
        if (dataUrl === undefined) missing.add(trimmed);
        return dataUrl;
      }
      default:
        blocked.add(trimmed);
        return undefined;
    }
  };
  const rewriteCss = (css: string) => rewriteCssUrls(css, (url) => {
    const replacement = inline(url);
    return replacement === undefined ? EMPTY_CSS_URL : `url("${cssString(replacement)}")`;
  });

  for (const element of [...doc.querySelectorAll("*")]) {
    const name = element.localName;
    if (name === "base" || isRefreshMeta(element)) {
      element.remove();
      continue;
    }
    if (name === "link") {
      if (isStylesheetLink(element)) {
        replaceStylesheetLink(doc, element, resources, inline, rewriteCss);
      } else {
        // Icons, preloads, prefetches and preconnects only reach the network.
        element.remove();
      }
      continue;
    }

    element.removeAttribute("ping");
    for (const attribute of RESOURCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null || !loadsResource(element, attribute)) continue;
      const replacement = inline(value);
      if (replacement === undefined) element.removeAttribute(attribute);
      else element.setAttribute(attribute, replacement);
    }
    for (const attribute of SRCSET_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const candidates = parseSrcset(value).flatMap((candidate) => {
        const replacement = inline(candidate.url);
        return replacement === undefined ? [] : [{ ...candidate, url: replacement }];
      });
      if (candidates.length === 0) element.removeAttribute(attribute);
      else element.setAttribute(attribute, serializeSrcset(candidates));
    }
    if (element.namespaceURI === SVG_NAMESPACE && name !== "a") {
      rewriteSvgHref(element, inline);
    }
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", rewriteCss(style));
    if (name === "style") element.textContent = rewriteCss(element.textContent ?? "");
    if (name === "a" && element.namespaceURI === SVG_NAMESPACE) {
      // SVG 1.1 links use xlink:href, which rewriteLink would leave pointing
      // at the app's own URL. SVG 2 reads plain href, so move it there.
      const legacy = element.getAttributeNS(XLINK_NAMESPACE, "href");
      element.removeAttributeNS(XLINK_NAMESPACE, "href");
      if (legacy !== null && !element.hasAttribute("href")) element.setAttribute("href", legacy);
    }
    if (name === "a" || name === "area") {
      rewriteLink(element, options.fileUrl);
    }
    if (name === "form") element.removeAttribute("target");
  }

  // A marker no page can predict holds the policy's place at the top of the
  // head, so each mode is one string splice.
  const marker = `pwragent-policy-${crypto.randomUUID()}`;
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  head.prepend(doc.createComment(marker));
  const serialized = serialize(doc);
  const at = serialized.indexOf(`<!--${marker}-->`);
  const before = serialized.slice(0, at);
  const after = serialized.slice(at + marker.length + 7);
  return {
    srcdoc: (scripts) => `${before}${policyHead(scripts)}${after}`,
    blockedRemote: blocked.size,
    missingLocal: missing.size,
  };
}

/** The `file:` URL for a local path, as the page's base for relative links. */
export function fileUrlForPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(rooted).replace(/[?#]/g, (char) => encodeURIComponent(char))}`;
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function loadsResource(element: Element, attribute: typeof RESOURCE_ATTRIBUTES[number]): boolean {
  return RESOURCE_ATTRIBUTE_ELEMENTS[attribute]?.has(element.localName) ?? true;
}

function isStylesheetLink(element: Element): boolean {
  return element.localName === "link"
    && /(?:^|\s)stylesheet(?:\s|$)/i.test(element.getAttribute("rel") ?? "");
}

function isRefreshMeta(element: Element): boolean {
  return element.localName === "meta"
    && (element.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh";
}

function svgHref(element: Element): string | null {
  return element.getAttribute("href") ?? element.getAttributeNS(XLINK_NAMESPACE, "href");
}

function rewriteSvgHref(element: Element, inline: (ref: string) => string | undefined): void {
  for (const [namespace, name] of [[null, "href"], [XLINK_NAMESPACE, "href"]] as const) {
    const value = namespace ? element.getAttributeNS(namespace, name) : element.getAttribute(name);
    if (value === null) continue;
    const replacement = inline(value);
    if (replacement === undefined) {
      if (namespace) element.removeAttributeNS(namespace, name);
      else element.removeAttribute(name);
    } else if (namespace) {
      element.setAttributeNS(namespace, "xlink:href", replacement);
    } else {
      element.setAttribute(name, replacement);
    }
  }
}

function replaceStylesheetLink(
  doc: Document,
  link: Element,
  resources: HtmlPreviewResources,
  inline: (ref: string) => string | undefined,
  rewriteCss: (css: string) => string,
): void {
  const href = link.getAttribute("href")?.trim() ?? "";
  const css = classifyHtmlPreviewRef(href) === "local" ? resources.stylesheets.get(href) : undefined;
  if (css === undefined) {
    // Records the miss or the blocked web stylesheet.
    if (href) inline(href);
    link.remove();
    return;
  }
  const style = doc.createElement("style");
  const media = link.getAttribute("media");
  if (media) style.setAttribute("media", media);
  style.textContent = rewriteCss(css);
  link.replaceWith(style);
}

/**
 * Links do not navigate the frame. The main process blocks the attempt and
 * hands the URL to the viewer, which asks before opening it. A fragment link
 * scrolls the page: written against `about:srcdoc`, it stays in the document
 * instead of resolving against the app's own URL.
 */
function rewriteLink(element: Element, fileUrl: string | undefined): void {
  element.removeAttribute("target");
  const href = element.getAttribute("href");
  if (href === null) return;
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    element.setAttribute("href", `about:srcdoc${trimmed}`);
    return;
  }
  if (/^javascript:/i.test(trimmed)) {
    element.removeAttribute("href");
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^file:/i.test(trimmed)) {
    return;
  }
  if (!fileUrl) {
    element.removeAttribute("href");
    return;
  }
  try {
    const target = new URL(trimmed, fileUrl);
    const link = new URL(HTML_PREVIEW_LOCAL_LINK_ORIGIN);
    link.searchParams.set("path", pathForFileUrl(target));
    link.hash = target.hash;
    element.setAttribute("href", link.href);
  } catch {
    element.removeAttribute("href");
  }
}

/** The local path a link from the frame names, if it names one. */
export function htmlPreviewLocalLinkPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== HTML_PREVIEW_LOCAL_LINK_ORIGIN) return undefined;
    return parsed.searchParams.get("path") || undefined;
  } catch {
    return undefined;
  }
}

function pathForFileUrl(url: URL): string {
  const decoded = decodeURIComponent(url.pathname);
  // file:///C:/dir/page.html names C:/dir/page.html.
  return /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
}

function policyHead(scripts: boolean): string {
  const policy = scripts ? SCRIPT_CSP : STATIC_CSP;
  const guard = scripts ? `<script>${SCRIPT_GUARD}</script>` : "";
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<meta http-equiv="x-dns-prefetch-control" content="off">'
    + guard;
}

function serialize(doc: Document): string {
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "";
  return `${doctype}${doc.documentElement.outerHTML}`;
}

function cssRefs(css: string): string[] {
  const refs: string[] = [];
  rewriteCssUrls(css, (url) => {
    refs.push(url);
    return undefined;
  });
  return refs;
}

/** Replace each `url()` the callback answers for; leave the rest as written. */
function rewriteCssUrls(css: string, replace: (url: string) => string | undefined): string {
  return css.replace(CSS_URL_PATTERN, (match, double?: string, single?: string, bare?: string) => {
    const url = (double ?? single ?? bare ?? "").trim();
    if (!url) return match;
    return replace(url) ?? match;
  });
}

function cssString(value: string): string {
  return value.replace(/["\\\n\r]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
}

/** A stylesheet's ref, rewritten to be relative to the page instead. */
function rebaseRef(stylesheetRef: string, ref: string): string {
  if (/^file:/i.test(ref) || ref.startsWith("/") || /^[a-z]:[/\\]/i.test(ref)) return ref;
  const base = stylesheetRef.split(/[?#]/, 1)[0] ?? "";
  const folder = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const joined = `${folder}${ref}`;
  const suffix = joined.slice(joined.split(/[?#]/, 1)[0]!.length);
  const parts: string[] = [];
  for (const part of joined.slice(0, joined.length - suffix.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  const leading = base.startsWith("/") ? "/" : "";
  return `${leading}${parts.join("/")}${suffix}`;
}

function decodeDataUrlText(dataUrl: string): string | undefined {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return undefined;
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  try {
    if (!/;base64$/i.test(meta)) return decodeURIComponent(payload);
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

type SrcsetCandidate = { url: string; descriptor: string };

/** The candidates of a `srcset`, split the way the HTML parser splits them. */
function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index]!)) index += 1;
    if (index >= value.length) break;
    let end = index;
    while (end < value.length && !/\s/.test(value[end]!)) end += 1;
    let url = value.slice(index, end);
    index = end;
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const comma = value.indexOf(",", index);
      const stop = comma < 0 ? value.length : comma;
      descriptor = value.slice(index, stop).trim();
      index = stop + 1;
    }
    if (url) candidates.push({ url, descriptor });
  }
  return candidates;
}

function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map((candidate) => candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url)
    .join(", ");
}
