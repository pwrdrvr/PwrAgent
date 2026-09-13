import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Dev-only: bridge the renderer to the standalone `react-devtools` app.
 *
 * Set to `1` to have the renderer HTML load the DevTools backend from
 * `http://<host>:<port>` as its very first script — the hook has to be
 * installed before `react-dom` initializes or React never registers a
 * renderer with it. Companion vars pick the endpoint; see
 * `apps/desktop/AGENTS.md` ("Profiling the Renderer with React DevTools").
 *
 * Read at Vite config time, not at app runtime. With the var unset the
 * plugin below is never constructed, so a normal `electron-vite build`
 * emits the same HTML it does today. `verify-asar-contents.mjs` fails
 * packaging if a bridged HTML ever reaches an app.asar anyway.
 */
const REACT_DEVTOOLS_ENV = "PWRAGENT_DEV_REACT_DEVTOOLS";
const REACT_DEVTOOLS_HOST_ENV = "PWRAGENT_DEV_REACT_DEVTOOLS_HOST";
const REACT_DEVTOOLS_PORT_ENV = "PWRAGENT_DEV_REACT_DEVTOOLS_PORT";
const DEFAULT_REACT_DEVTOOLS_HOST = "localhost";
const DEFAULT_REACT_DEVTOOLS_PORT = "8097";

/**
 * Dev-only: build the renderer against `react-dom/profiling` instead of
 * `react-dom/client`, so the DevTools Profiler can record a production
 * bundle. A plain production `react-dom` is compiled without the timing
 * instrumentation and the Profiler tab reports "Profiling not supported".
 *
 * Only `react-dom/client` is aliased. Every other entry — bare `react-dom`
 * for `createPortal`/`flushSync`, and `react-dom/server` — keeps resolving
 * normally, which is what keeps a single reconciler in the bundle: in
 * React 19 both `react-dom/client` and `react-dom/profiling` require the
 * shared bare `react-dom` module for their internals, so swapping the
 * client entry alone cannot produce two copies.
 */
const REACT_PROFILING_ENV = "PWRAGENT_DEV_REACT_PROFILING";

function isEnabled(name: string): boolean {
  const value = process.env[name]?.trim();
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Injects the standalone React DevTools backend as the first `<head>`
 * script. `head-prepend` matters: it lands above the appearance bootstrap
 * and above the `/src/main.tsx` module, which is the ordering the DevTools
 * hook needs.
 *
 * The script also logs the endpoint to the renderer console. Several
 * PwrAgent checkouts usually run at once on one machine and the standalone
 * DevTools window says nothing about which page it is attached to, so that
 * line is how an operator confirms that *this* window is the one talking to
 * the DevTools instance on that port.
 */
function reactDevtoolsBridge(): Plugin {
  const host = process.env[REACT_DEVTOOLS_HOST_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_HOST;
  const port = process.env[REACT_DEVTOOLS_PORT_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_PORT;
  const endpoint = `http://${host}:${port}`;
  return {
    name: "pwragent:react-devtools-bridge",
    transformIndexHtml: {
      order: "pre",
      handler: () => ({
        html: "",
        tags: [
          {
            tag: "script",
            attrs: { src: endpoint },
            injectTo: "head-prepend" as const,
          },
          {
            tag: "script",
            children: `console.info(${JSON.stringify(
              `[pwragent] React DevTools bridge -> ${endpoint} (renderer from ${__dirname})`,
            )});`,
            injectTo: "head-prepend" as const,
          },
        ],
      }),
    },
  };
}

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

  const devtoolsBridgeEnabled = isEnabled(REACT_DEVTOOLS_ENV);
  // The profiling alias is a build-only swap. `electron-vite dev` already
  // serves react-dom's development build, which carries the Profiler and
  // the hook-level "why did this render" attribution the production
  // profiling build drops — so aliasing in dev would cost a dependency
  // re-optimization and buy nothing.
  const profilingEnabled = isEnabled(REACT_PROFILING_ENV);
  if (profilingEnabled && !isBuild) {
    console.warn(
      `[pwragent] ${REACT_PROFILING_ENV} is set but only applies to \`electron-vite build\`;`
      + " the dev server already serves a profilable react-dom.",
    );
  }
  if (profilingEnabled && isBuild) {
    console.warn(
      `[pwragent] ${REACT_PROFILING_ENV} is set: aliasing react-dom/client -> react-dom/profiling.`
      + " Do not ship this build.",
    );
  }
  if (devtoolsBridgeEnabled && isBuild) {
    console.warn(
      `[pwragent] ${REACT_DEVTOOLS_ENV} is set: the built renderer HTML will load the`
      + " React DevTools backend over http. Do not ship this build.",
    );
  }

  return {
    main: {
      define: productionDefine,
      build: {
        externalizeDeps: {
          exclude: [
            "@pwragent/shared",
            "@pwrdrvr/codex-app-server-protocol",
            "@pwragent/messaging-interface",
            "@pwragent/messaging-provider-discord",
            "@pwragent/messaging-provider-feishu",
            "@pwragent/messaging-provider-line",
            "@pwragent/messaging-provider-mattermost",
            "@pwragent/messaging-provider-slack",
            "@pwragent/messaging-provider-telegram",
            "@larksuiteoapi/node-sdk",
            "protobufjs",
            "protobufjs/minimal",
            // Slack's bundled CommonJS Socket Mode client expects
            // require("ws").WebSocket. Externalizing ws rewrites that require
            // to an ESM default import whose constructor has no .WebSocket.
            "ws",
          ]
        },
        commonjsOptions: {
          transformMixedEsModules: true
        },
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/main/index.ts"),
            "mcp-connection-bridge": resolve(
              __dirname,
              "src/main/mcp-connections/mcp-connection-bridge-entry.ts"
            ),
            "token-miser-hook": resolve(
              __dirname,
              "src/main/token-miser/token-miser-hook-entry.ts"
            )
          },
          output: {
            entryFileNames: "[name].js"
          },
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
        externalizeDeps: {
          exclude: ["@pwragent/shared"]
        },
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          output: {
            format: "cjs"
          }
        }
      }
    },
    renderer: {
      plugins: devtoolsBridgeEnabled
        ? [react(), reactDevtoolsBridge()]
        : [react()],
      optimizeDeps: {
        esbuildOptions: {
          minify: true,
        },
      },
      resolve: {
        alias: {
          "@renderer": resolve(__dirname, "src/renderer/src"),
          ...(profilingEnabled && isBuild
            ? { "react-dom/client": "react-dom/profiling" }
            : {})
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
