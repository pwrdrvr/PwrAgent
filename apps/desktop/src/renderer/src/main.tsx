import React, { type ReactElement } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ChangelogWindow } from "./features/changelog/ChangelogWindow";
import { LogsWindow } from "./features/logs/LogsWindow";
import { MessagingActivityWindow } from "./features/messaging-activity/MessagingActivityWindow";
import { RendererErrorBoundary } from "./features/diagnostics/RendererErrorBoundary";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import "./styles/app.css";

installGlobalRendererErrorHandlers();

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
    <RendererErrorBoundary>{chooseRoot()}</RendererErrorBoundary>
  </React.StrictMode>,
);
