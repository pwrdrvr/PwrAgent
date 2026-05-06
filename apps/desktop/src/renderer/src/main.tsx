import React, { type ReactElement } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MessagingActivityWindow } from "./features/messaging-activity/MessagingActivityWindow";
import { RendererErrorBoundary } from "./features/diagnostics/RendererErrorBoundary";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import "./styles/app.css";

installGlobalRendererErrorHandlers();

/**
 * Pick which root component to mount based on `window.location.hash`.
 *
 * The Messaging Activity surface lives in its own BrowserWindow (see
 * `apps/desktop/src/main/messaging-activity-window.ts`). That window
 * loads the same renderer bundle but with the `#messaging-activity`
 * hash so we mount only the activity surface here — no sidebar, no
 * thread view, no settings shell.
 *
 * The default (no hash, or any unrecognized hash) is the full app.
 */
function chooseRoot(): ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "messaging-activity") {
    return <MessagingActivityWindow />;
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>{chooseRoot()}</RendererErrorBoundary>
  </React.StrictMode>,
);
