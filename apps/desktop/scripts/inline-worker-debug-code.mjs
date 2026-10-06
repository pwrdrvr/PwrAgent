// Vite retains an inline worker's map as an asset, but only embeds its code
// in the blob wrapper. Keep an exact JS companion so the debug artifact can
// validate/hash that code and use the adjacent map offline.
export function inlineWorkerDebugCode() {
  const entries = new Map();
  return {
    /** @type {import("vite").Plugin} */
    worker: {
      name: "pwragent:capture-worker-debug-code",
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === "chunk" && chunk.isEntry && chunk.map) {
            entries.set(chunk.fileName, chunk.code);
          }
        }
      },
    },
    /** @type {import("vite").Plugin} */
    renderer: {
      name: "pwragent:retain-inline-worker-debug-code",
      buildStart() {
        entries.clear();
      },
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          for (const [fileName, source] of entries) {
            if (bundle[`${fileName}.map`] && !bundle[fileName]) {
              this.emitFile({ type: "asset", fileName, source });
            }
          }
        },
      },
    },
  };
}
