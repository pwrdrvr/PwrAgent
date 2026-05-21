import React, { Suspense, lazy, type ReactElement } from "react";
import ReactDOM from "react-dom/client";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
} from "@pwragent/shared";
import { App } from "./App";
import { RendererErrorBoundary } from "./features/diagnostics/RendererErrorBoundary";
import { applyAppearanceAttributes, resolveTheme } from "./lib/appearance";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import "./styles/app.css";

installGlobalRendererErrorHandlers();

// Subscribe to main → renderer appearance broadcasts. Every window
// (including secondary surfaces like changelog, app-log, license,
// messaging activity) listens here so when the user changes theme or
// density in Settings, the active <html data-theme/data-density>
// attributes update everywhere instead of staying stuck on whatever
// the window bootstrapped with at creation. The main window's
// useAppearance hook also re-applies via its own React state path,
// which means this listener can run unconditionally — the DOM write
// it performs is idempotent against the hook's parallel write.
//
// Done outside React so aux windows (which don't mount useAppearance)
// still get the theme-flip behavior.
const desktopApi = (
  window as unknown as {
    pwragent?: {
      onAppearanceChanged?: (
        callback: (appearance: {
          theme: DesktopAppearanceTheme;
          density: DesktopAppearanceDensity;
        }) => void,
      ) => () => void;
      platform?: string;
    };
  }
).pwragent;
if (desktopApi?.platform) {
  document.documentElement.dataset.platform = desktopApi.platform;
}
const unsubscribeAppearance = desktopApi?.onAppearanceChanged?.(
  (appearance) => {
    applyAppearanceAttributes(
      resolveTheme(appearance.theme),
      appearance.density,
    );
  },
);

// Dev-only: HMR reloads re-evaluate this module without disposing the
// previous listener, so without this we'd accumulate one
// onAppearanceChanged listener per HMR cycle. In production builds
// `import.meta.hot` is undefined and the dispose registration is a
// no-op — same listener, single lifetime.
//
// `import.meta.hot` is a Vite-injected dev-only property. We could pull
// in `vite/client` triple-slash types globally, but that drags more
// surface than we need; this single-site shape augmentation keeps the
// type narrowed without polluting the rest of the renderer types.
const importMetaHot = (
  import.meta as ImportMeta & {
    hot?: { dispose: (callback: () => void) => void };
  }
).hot;
if (importMetaHot) {
  importMetaHot.dispose(() => {
    unsubscribeAppearance?.();
  });
}

const ChangelogWindow = lazy(async () => ({
  default: (await import("./features/changelog/ChangelogWindow")).ChangelogWindow,
}));
const LogsWindow = lazy(async () => ({
  default: (await import("./features/logs/LogsWindow")).LogsWindow,
}));
const LicenseDocumentWindow = lazy(async () => ({
  default: (await import("./features/license/LicenseDocumentWindow"))
    .LicenseDocumentWindow,
}));
const MessagingActivityWindow = lazy(async () => ({
  default: (await import("./features/messaging-activity/MessagingActivityWindow"))
    .MessagingActivityWindow,
}));

/**
 * Routes recognized by `chooseRoot` below. The Messaging Activity
 * window loads the same renderer bundle as the main shell but with a
 * URL hash — `main.tsx` reads the hash and mounts a different root
 * for that window. New secondary windows add an entry here; the
 * default fallback is the full `<App />` shell.
 *
 * Each route's `match` runs against the bare hash (no leading `#`).
 * Use `=== "literal"` for exact matches today; if a future deep-link
 * uses a path-style hash like `thread/abc123`, adjust the matcher
 * (e.g. `(h) => h.startsWith("thread/")`) without restructuring.
 */
const routes: Array<{
  match: (hash: string) => boolean;
  render: () => ReactElement;
}> = [
  {
    match: (hash) => hash === "messaging-activity",
    render: () => <MessagingActivityWindow />,
  },
  {
    match: (hash) => hash === "changelog",
    render: () => <ChangelogWindow />,
  },
  {
    match: (hash) => hash === "license" || hash === "third-party-notices",
    render: () => <LicenseDocumentWindow />,
  },
  {
    match: (hash) => hash === "logs",
    render: () => <LogsWindow />,
  },
];

function chooseRoot(): ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  return routes.find((route) => route.match(hash))?.render() ?? <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <Suspense fallback={null}>{chooseRoot()}</Suspense>
    </RendererErrorBoundary>
  </React.StrictMode>,
);
