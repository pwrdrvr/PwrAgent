// The two halves of the release-notes link live in different packages and
// have to agree: `releaseNotesUrl` (packages/shared) composes the URL, and
// `applyWindowSecurityHardening` (this folder's ../window) decides whether
// the process that owns `shell.openExternal` will open it.
//
// PwrAgent's renderer has no `openExternal` IPC channel. Every external open
// — PR chips, managed Grok release pages, and now `ReleaseNotesLink` — is a
// `window.open(url, "_blank")` that Chromium routes to the window's
// `setWindowOpenHandler`, which is where `isSafeExternalOpenUrl` runs. So
// that handler is the thing to exercise. A shared-package test could only
// re-state its rule; this one runs it, from the real
// `applyWindowSecurityHardening` on a real composed URL.
//
// The composer is deliberately narrow — anchored semver, one path template —
// so the interesting question is not "does a good URL pass" alone but "can
// the composer be made to produce one that shouldn't".
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_RELEASES_URL,
  PWRAGENT_REPO_URL,
  releaseNotesUrl,
} from "@pwragent/shared";

const openExternal = vi.fn(async (_url: string): Promise<void> => undefined);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/app",
    getVersion: () => "1.0.6",
    getPath: () => "/tmp",
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: (url: string) => openExternal(url) },
}));

const { applyWindowSecurityHardening } = await import("../window");

type NavigateEvent = { preventDefault: () => void };

/** A window carrying only the two seams the guards attach to. Everything the
 *  hardening installs is captured so it can be driven directly. */
function hardenedWindow() {
  let openHandler: ((details: { url: string }) => unknown) | undefined;
  let navigateListener:
    | ((event: NavigateEvent, targetUrl: string) => void)
    | undefined;

  const webContents = {
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
      openHandler = handler;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === "will-navigate") {
        navigateListener = listener as unknown as typeof navigateListener;
      }
    },
  };

  applyWindowSecurityHardening({
    webContents,
  } as unknown as Parameters<typeof applyWindowSecurityHardening>[0]);

  return {
    /** What `window.open(url, "_blank")` from the renderer reaches. */
    open(url: string): { openedExternally: boolean; action: unknown } {
      const before = openExternal.mock.calls.length;
      const result = openHandler?.({ url }) as { action?: unknown };
      return {
        openedExternally: openExternal.mock.calls.length > before,
        action: result?.action,
      };
    },
    /** What a real `<a href>` middle-click would reach instead. */
    navigate(url: string): { blocked: boolean } {
      let blocked = false;
      navigateListener?.({ preventDefault: () => (blocked = true) }, url);
      return { blocked };
    },
  };
}

afterEach(() => {
  openExternal.mockClear();
});

describe("a composed release-notes URL survives the window guards", () => {
  it.each([
    ["a stable tag", "1.0.6"],
    ["a tag carrying the leading v", "v1.0.6"],
    ["a beta tag", "1.1.0-beta.1"],
    ["an alpha tag", "v1.1.0-alpha.5"],
    ["the older prerelease tag shape", "v1.0.2-prerelease.2"],
    ["build metadata, which escapes to %2B", "1.0.6+build.3"],
  ])("hands the release page for %s to the OS browser", (_label, version) => {
    const url = releaseNotesUrl(version);
    expect(url).toBeDefined();

    const { openedExternally, action } = hardenedWindow().open(url as string);

    expect(openedExternally).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(url);
    // Handed to the OS and denied in-window — both halves matter. An
    // `action: "allow"` here would put github.com inside a BrowserWindow
    // with this app's preload on it.
    expect(action).toBe("deny");
  });

  it("opens the two constants a caller falls back to", () => {
    const window = hardenedWindow();
    for (const url of [PWRAGENT_REPO_URL, PWRAGENT_RELEASES_URL]) {
      expect(window.open(url).openedExternally).toBe(true);
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it("refuses to NAVIGATE to one, however it is reached", () => {
    // The other half of the guard. `ReleaseNotesLink` is a button precisely
    // so this path is never taken, but the app's own two `<a target=_blank>`
    // rows in Settings → About make it reachable, and a middle-click on one
    // must still not put a remote origin in the window.
    const url = releaseNotesUrl("1.0.6") as string;
    expect(hardenedWindow().navigate(url).blocked).toBe(true);
  });

  it("still refuses what the guard exists to refuse", () => {
    // Positive control. Without it every case above would pass just as
    // happily against a handler that opened anything — which is exactly the
    // shape this guard has to NOT have, since `isSafeExternalOpenUrl` admits
    // any https origin and the composer's anchored pattern is the only thing
    // keeping a crafted "version" off the https path in the first place.
    const window = hardenedWindow();
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://evil.example.com/pwrdrvr/PwrAgent/releases",
      "pwragent://thread/019f5d79-a595-73f2-84d9-a0976762c303",
      "not a url",
    ]) {
      const { openedExternally, action } = window.open(url);
      expect(openedExternally).toBe(false);
      expect(action).toBe("deny");
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("composes nothing for the versions that would reach those refusals", () => {
    // The seam between the two halves: a crafted version never becomes a
    // URL, so the guard is never asked about one.
    for (const version of [
      "1.0.6/../../pwrdrvr/PwrAgent/settings",
      "javascript:alert(1)",
      "https://evil.example.com",
      "unknown",
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });
});
