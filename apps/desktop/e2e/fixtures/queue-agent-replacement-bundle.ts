import type { Plugin } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Keep native host dependencies reachable from the isolated temporary driver. */
export function replacementHostDependencies(resolveDependency: (specifier: string) => string): Plugin {
  return { name: "replacement-host-dependencies", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.kind === "entry-point" || path.posix.isAbsolute(args.path) || path.win32.isAbsolute(args.path)) return;
      if (args.path.startsWith("node:") || args.path === "electron"
        || args.path.startsWith("@pwragent/") || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) return;
      try {
        const resolved = resolveDependency(args.path);
        // Native import() requires a file URL for Windows drive paths and
        // must not interpret a dependency filename's # or % as URL syntax.
        return { path: args.kind === "dynamic-import" ? pathToFileURL(resolved).href : resolved, external: true };
      } catch { return; }
    });
  } };
}
