import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

/** The actual isolated desktop owner's bundle plugin, shared with its oracle. */
export function queuePausePublicationPlugin(specDir: string, resolveDependency: (id: string) => string): Plugin {
  return { name: "isolated-desktop-pause-owner", setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "pause-raw" }));
    builder.onLoad({ filter: /.*/, namespace: "pause-raw" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.kind === "entry-point" || path.isAbsolute(args.path) || path.win32.isAbsolute(args.path)) return;
      if (args.path.startsWith("node:") || args.path === "electron"
        || args.path.startsWith("@pwragent/") || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) return;
      try { return { path: resolveDependency(args.path), external: true }; } catch { return; }
    });
    builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "pause-owner" }));
    builder.onLoad({ filter: /.*/, namespace: "pause-owner" }, () => ({
      contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(path.resolve(specDir, "../src/main/__tests__/fixtures/owner-conformance-codex-transport.ts"))};`,
      loader: "ts", resolveDir: specDir,
    }));
  } };
}
