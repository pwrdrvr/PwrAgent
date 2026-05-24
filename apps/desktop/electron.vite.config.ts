import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// electron-vite defaults `build.minify` to false for all three targets.
// For shipped builds we want minified main/preload/renderer with sourcemaps
// stripped. esbuild minification is the right default; switch to terser only
// if a measured size win justifies the build-time cost.
//
// The function form is needed so we can conditionally define process.env.NODE_ENV
// only during `electron-vite build`. Without this, the built main/preload bundles
// keep process.env.NODE_ENV as a runtime reference — and in the packaged .app
// it's undefined, so isDevelopment checks resolve to true.
export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  return {
    main: {
      define: productionDefine,
      plugins: [
        externalizeDepsPlugin({
          exclude: [
            "@pwragent/shared",
            "@pwragent/codex-app-server-protocol",
            "@pwragent/agent-core",
            "@pwragent/messaging-interface",
            "@pwragent/messaging-provider-discord",
            "@pwragent/messaging-provider-feishu",
            "@pwragent/messaging-provider-line",
            "@pwragent/messaging-provider-mattermost",
            "@pwragent/messaging-provider-slack",
            "@pwragent/messaging-provider-telegram",
            "@larksuiteoapi/node-sdk",
            "protobufjs",
            "protobufjs/minimal"
          ]
        })
      ],
      build: {
        commonjsOptions: {
          transformMixedEsModules: true
        },
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          external: [
            "abort-controller",
            "bufferutil",
            "node-fetch",
            "utf-8-validate",
            "zlib-sync"
          ]
        }
      }
    },
    preload: {
      define: productionDefine,
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
          exclude: ["@pwragent/shared"]
        })
      ]
    },
    renderer: {
      plugins: [react()],
      optimizeDeps: {
        esbuildOptions: {
          minify: true,
        },
      },
      resolve: {
        alias: {
          "@renderer": resolve(__dirname, "src/renderer/src")
        }
      },
      build: {
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.includes("node_modules")) {
                if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
                  return "vendor-react";
                }
                if (/[\\/]node_modules[\\/](react-markdown|remark-|unified|mdast-|micromark|markdown-|vfile|hast-)[\\/]/.test(id)) {
                  return "vendor-markdown";
                }
                if (/[\\/]node_modules[\\/](@tiptap|prosemirror-|@popperjs|tippy)[\\/]/.test(id)) {
                  return "vendor-tiptap";
                }
              }
            }
          }
        }
      }
    }
  };
});
