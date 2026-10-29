import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererEntry } from "../renderer-entry-url";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  mediaCheck: vi.fn((_contents: unknown, _details: unknown) => true),
  mediaRequest: vi.fn((_contents: unknown, _details: unknown) => true),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ warn: mocks.warn, info: vi.fn() }) }));

const { createPermissionPolicy, installPermissionPolicy } = await import("../permission-policy");

const ENTRY: RendererEntry = { kind: "file", value: "/fixture/app/out/renderer/index.html" };
const APP_URL = `${pathToFileURL(ENTRY.value).href}#star-map`;
const DEV_ENTRY: RendererEntry = { kind: "url", value: "http://localhost:5173" };

type Policy = ReturnType<typeof createPermissionPolicy>;
type Contents = Parameters<Policy["request"]>[0];

function contents(url = APP_URL): Contents {
  return { id: 7, getURL: () => url } as unknown as Contents;
}

function policy(entry: RendererEntry = ENTRY): Policy {
  return createPermissionPolicy({
    rendererEntry: entry,
    media: { check: mocks.mediaCheck, request: mocks.mediaRequest },
  });
}

function check(
  permission: string,
  details: { isMainFrame: boolean; requestingUrl?: string; mediaType?: string },
  options: { entry?: RendererEntry; contents?: Contents | null } = {},
): boolean {
  const handler = policy(options.entry).check as unknown as (
    contents: Contents | null, permission: string, origin: string, details: unknown,
  ) => boolean;
  const target = options.contents === undefined ? contents() : options.contents;
  return handler(target, permission, "", details);
}

function request(
  permission: string,
  details: { isMainFrame: boolean; requestingUrl: string; mediaTypes?: string[] },
  entry?: RendererEntry,
): unknown {
  const callback = vi.fn();
  const handler = policy(entry).request as unknown as (
    contents: Contents, permission: string, callback: (granted: boolean) => void, details: unknown,
  ) => void;
  handler(contents(), permission, callback, details);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0]?.[0];
}

const DENIED_PERMISSIONS = [
  "clipboard-read",
  "deprecated-sync-clipboard-read",
  "notifications",
  "geolocation",
  "midi",
  "midiSysex",
  "pointerLock",
  "keyboardLock",
  "fullscreen",
  "openExternal",
  "display-capture",
  "idle-detection",
  "mediaKeySystem",
  "speaker-selection",
  "storage-access",
  "top-level-storage-access",
  "window-management",
  "fileSystem",
  "hid",
  "serial",
  "usb",
  "unknown",
  "a-permission-added-in-a-future-electron",
];

const APP_MAIN_FRAME = { isMainFrame: true, requestingUrl: APP_URL };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mediaCheck.mockReturnValue(true);
  mocks.mediaRequest.mockReturnValue(true);
});

describe("permission check handler", () => {
  it("allows a clipboard write from the app's main frame", () => {
    expect(check("clipboard-sanitized-write", APP_MAIN_FRAME)).toBe(true);
  });

  it.each(DENIED_PERMISSIONS)("denies %s even to the app's main frame", (permission) => {
    expect(check(permission, APP_MAIN_FRAME)).toBe(false);
  });

  it("delegates media from the app's main frame to the voice rules", () => {
    const details = { ...APP_MAIN_FRAME, mediaType: "audio" };
    expect(check("media", details)).toBe(true);
    expect(mocks.mediaCheck).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), details);
    mocks.mediaCheck.mockReturnValue(false);
    expect(check("media", details)).toBe(false);
  });

  it("denies every permission to a subframe, without asking the voice rules", () => {
    for (const requestingUrl of ["about:srcdoc", APP_URL, "null"]) {
      expect(check("clipboard-sanitized-write", { isMainFrame: false, requestingUrl })).toBe(false);
      expect(check("media", { isMainFrame: false, requestingUrl, mediaType: "audio" })).toBe(false);
    }
    // Cross-origin subframes carry no requesting URL at all.
    expect(check("clipboard-sanitized-write", { isMainFrame: false })).toBe(false);
    expect(mocks.mediaCheck).not.toHaveBeenCalled();
  });

  it("denies a main frame showing any document other than the renderer entry", () => {
    for (const requestingUrl of [
      "file:///tmp/x.html",
      pathToFileURL("/fixture/app/out/renderer/other.html").href,
      "https://example.com/",
      "data:text/html,x",
      "about:blank",
    ]) {
      expect(check("clipboard-sanitized-write", { isMainFrame: true, requestingUrl }), requestingUrl).toBe(false);
      expect(check("media", { isMainFrame: true, requestingUrl, mediaType: "audio" }), requestingUrl).toBe(false);
    }
    expect(mocks.mediaCheck).not.toHaveBeenCalled();
  });

  it("uses the window's URL only for a main-frame check that carries none", () => {
    expect(check("clipboard-sanitized-write", { isMainFrame: true })).toBe(true);
    expect(check("clipboard-sanitized-write", { isMainFrame: true }, { contents: contents("file:///tmp/x.html") })).toBe(false);
    expect(check("clipboard-sanitized-write", { isMainFrame: false }, { contents: contents(APP_URL) })).toBe(false);
  });

  it("denies a check with no web contents", () => {
    expect(check("clipboard-sanitized-write", APP_MAIN_FRAME, { contents: null })).toBe(false);
  });

  it("follows the dev server origin in development and refuses file documents there", () => {
    const dev = { isMainFrame: true, requestingUrl: "http://localhost:5173/#settings" };
    expect(check("clipboard-sanitized-write", dev, { entry: DEV_ENTRY })).toBe(true);
    expect(check("clipboard-sanitized-write", APP_MAIN_FRAME, { entry: DEV_ENTRY })).toBe(false);
    expect(check("clipboard-sanitized-write", { isMainFrame: true, requestingUrl: "http://localhost:5174/" }, { entry: DEV_ENTRY })).toBe(false);
  });
});

describe("permission request handler", () => {
  it("grants a clipboard write to the app's main frame", () => {
    expect(request("clipboard-sanitized-write", APP_MAIN_FRAME)).toBe(true);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(DENIED_PERMISSIONS)("denies %s even to the app's main frame, and logs it", (permission) => {
    expect(request(permission, APP_MAIN_FRAME)).toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith("denied renderer permission request", {
      permission,
      isMainFrame: true,
    });
  });

  it("delegates media from the app's main frame to the voice rules", () => {
    const details = { ...APP_MAIN_FRAME, mediaTypes: ["audio"] };
    expect(request("media", details)).toBe(true);
    expect(mocks.mediaRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), details);
    mocks.mediaRequest.mockReturnValue(false);
    expect(request("media", details)).toBe(false);
    // Voice being off is routine; it is not worth a warning.
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("denies the interactive SVG iframe everything", () => {
    for (const permission of ["clipboard-sanitized-write", "media", "notifications", "fullscreen", "clipboard-read"]) {
      expect(request(permission, { isMainFrame: false, requestingUrl: "about:srcdoc", mediaTypes: ["audio"] }), permission).toBe(false);
    }
    expect(mocks.mediaRequest).not.toHaveBeenCalled();
  });

  it("denies a subframe that shares the app's URL", () => {
    expect(request("clipboard-sanitized-write", { isMainFrame: false, requestingUrl: APP_URL })).toBe(false);
    expect(request("media", { isMainFrame: false, requestingUrl: APP_URL, mediaTypes: ["audio"] })).toBe(false);
    expect(mocks.mediaRequest).not.toHaveBeenCalled();
  });

  it("denies a main frame navigated to another local document", () => {
    const requestingUrl = "file:///Users/sample/Downloads/preview.html";
    expect(request("clipboard-sanitized-write", { isMainFrame: true, requestingUrl })).toBe(false);
    expect(request("media", { isMainFrame: true, requestingUrl, mediaTypes: ["audio"] })).toBe(false);
    expect(mocks.mediaRequest).not.toHaveBeenCalled();
  });

  it("follows the dev server origin in development", () => {
    expect(request("clipboard-sanitized-write", { isMainFrame: true, requestingUrl: "http://localhost:5173/" }, DEV_ENTRY)).toBe(true);
    expect(request("clipboard-sanitized-write", APP_MAIN_FRAME, DEV_ENTRY)).toBe(false);
  });
});

describe("installPermissionPolicy", () => {
  it("installs both handlers on the session", () => {
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
    installPermissionPolicy(session, {
      rendererEntry: ENTRY,
      media: { check: mocks.mediaCheck, request: mocks.mediaRequest },
    });
    expect(session.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(session.setPermissionRequestHandler).toHaveBeenCalledWith(expect.any(Function));
    const installedCheck = session.setPermissionCheckHandler.mock.calls[0]?.[0] as (...args: unknown[]) => boolean;
    expect(installedCheck(contents(), "notifications", "file:///", APP_MAIN_FRAME)).toBe(false);
    expect(installedCheck(contents(), "clipboard-sanitized-write", "file:///", APP_MAIN_FRAME)).toBe(true);
  });
});
