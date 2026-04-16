import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@pwragnt/shared"]
      })
    ]
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@pwragnt/shared"]
      })
    ]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src")
      }
    }
  }
});
