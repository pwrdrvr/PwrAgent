import type { Plugin } from "vite";

export function inlineWorkerDebugCode(): {
  worker: Plugin;
  renderer: Plugin;
};
