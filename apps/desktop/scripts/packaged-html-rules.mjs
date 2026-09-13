// Content rules for HTML that ships inside app.asar.
//
// The path-pattern table in `verify-asar-contents.mjs` answers "may this file
// be in the bundle at all". These answer "is the content of a file that may be
// in the bundle acceptable", which needs the bytes rather than the path. Kept
// in their own module so they are unit-testable: the verifier itself is a
// top-level script that calls `process.exit`, so nothing can import it.

/**
 * The app's own renderer HTML, as `asar.listPackage` spells it (leading slash,
 * forward slashes already normalized by `normalizeAsarListing`).
 *
 * Scoped to `/out/` on purpose. electron-builder ships `out/**` plus the
 * auto-included production `node_modules`, and a dependency that vendors a
 * playground page pointing at a CDN is not this repository's problem: the app
 * never loads it, and failing a release on it would tell the operator to unset
 * a flag that has nothing to do with the file. `/out/` is also never unpacked,
 * which keeps `extractFile` off the `.unpacked` sidecar path that may not be
 * colocated in the staged Windows signing job.
 */
export function isRendererHtmlEntry(entry) {
  return /^\/out\/.*\.html?$/i.test(entry);
}

/**
 * A `<script src>` pointing anywhere outside the asar: absolute http(s) or
 * protocol-relative.
 *
 * The whitespace before `src` is load-bearing. `\bsrc` would also match the
 * hyphenated attributes (`data-src`, `x-src`) that lazy-loaders use as inert
 * placeholders, and flagging one of those would fail a release over markup
 * that loads nothing.
 */
const REMOTE_SCRIPT_PATTERN =
  /<script\b[^>]*\ssrc\s*=\s*["']?(?:https?:)?\/\//i;

export function findRemoteScript(contents) {
  return REMOTE_SCRIPT_PATTERN.exec(contents)?.[0] ?? null;
}
