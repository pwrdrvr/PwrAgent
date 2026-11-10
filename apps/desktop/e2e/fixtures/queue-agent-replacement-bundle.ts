import type { Plugin } from "esbuild";
import path from "node:path";

/** Keep native host dependencies reachable from the isolated temporary driver. */
export function replacementHostDependencies(resolveDependency: (specifier: string) => string): Plugin {
  return { name: "replacement-host-dependencies", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.kind === "entry-point" || path.posix.isAbsolute(args.path) || path.win32.isAbsolute(args.path)) return;
      if (args.path.startsWith("node:") || args.path === "electron"
        || args.path.startsWith("@pwragent/") || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) return;
      try { return { path: resolveDependency(args.path), external: true }; } catch { return; }
    });
  } };
}
