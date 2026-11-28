import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: resolve(import.meta.dirname, "../node_modules/.vite/renderer-layout"),
  plugins: [react()],
  server: { fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] } },
});
