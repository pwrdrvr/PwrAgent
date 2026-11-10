import type { AppServerThreadImagePart } from "./contracts/normalized-app-server";

// This package compiles without DOM or Node types. Every runtime it ships to
// (Electron main, renderer, Node tests) has the WHATWG URL global.
type ParsedUrl = {
  protocol: string;
  host: string;
  origin: string;
  pathname: string;
  username: string;
  password: string;
};
declare const URL: new (input: string) => ParsedUrl;

/** The largest transcript image PwrAgent copies, decoded. */
export const MAX_TRANSCRIPT_IMAGE_BYTES = 64 * 1024 * 1024;

const PWRSNAP_RESOURCE_SCHEME = "pwrsnap:";
const MAX_PWRSNAP_RESOURCE_URI_LENGTH = 2048;
const LEGACY_PWRSNAP_MEDIA_ORIGIN = "http://127.0.0.1:51729";
const PWRSNAP_IMAGE_UNAVAILABLE = "PwrSnap image unavailable.";

/**
 * PwrSnap 1.3 returns media as canonical `pwrsnap://` MCP resource links.
 * Their bytes come only from `resources/read` on the live session that
 * returned them, so this check says only what a link claims to be. Whether
 * PwrAgent may read it is the MCP gateway's decision.
 */
export function isPwrSnapResourceUri(value: string): boolean {
  if (value.length > MAX_PWRSNAP_RESOURCE_URI_LENGTH) return false;
  let parsed: ParsedUrl;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === PWRSNAP_RESOURCE_SCHEME
    && Boolean(parsed.host)
    && !parsed.username
    && !parsed.password;
}

/**
 * PwrSnap before 1.3 served signed media from a fixed loopback port. That
 * listener no longer exists, so these URLs are never requested: transcripts
 * that hold one show the image as unavailable.
 */
export function isLegacyPwrSnapMediaUrl(value: string): boolean {
  let parsed: ParsedUrl;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === LEGACY_PWRSNAP_MEDIA_ORIGIN && parsed.pathname === "/media";
}

/**
 * Why an image part must not be loaded, if it must not. The owner sets a
 * reason when it could not obtain the bytes. A PwrSnap link that reaches a
 * renderer without one, such as from an older federation peer, is never
 * loadable there either: only the owner's MCP session can read it, and the
 * loopback listener is gone.
 */
export function transcriptImageUnavailableReason(
  image: Pick<AppServerThreadImagePart, "url" | "unavailableReason">,
): string | undefined {
  if (image.unavailableReason) return image.unavailableReason;
  return isPwrSnapResourceUri(image.url) || isLegacyPwrSnapMediaUrl(image.url)
    ? PWRSNAP_IMAGE_UNAVAILABLE
    : undefined;
}
