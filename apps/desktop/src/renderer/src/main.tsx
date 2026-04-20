import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { RendererErrorBoundary } from "./features/diagnostics/RendererErrorBoundary";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import "./styles/app.css";

installGlobalRendererErrorHandlers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);
