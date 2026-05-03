import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// electron-vite defaults `build.minify` to false for all three targets.
// For shipped builds we want minified main/preload/renderer with sourcemaps
// stripped. esbuild minification is the right default; switch to terser only
// if a measured size win justifies the build-time cost.
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@pwragnt/shared", "@pwragnt/agent-core"]
      })
    ],
    build: {
      minify: "esbuild",
      sourcemap: false
    }
  },
  preload: {
    build: {
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    },
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
    },
    build: {
      minify: "esbuild",
      sourcemap: false
    }
  }
});
