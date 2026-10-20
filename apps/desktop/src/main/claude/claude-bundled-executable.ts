import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Resolve only the native binary installed with our pinned SDK dependency. */
export async function resolveBundledClaudeExecutable(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  libc?: "glibc" | "musl";
  resolveModule?: (specifier: string) => string;
  validatePath?: (candidate: string) => Promise<string>;
} = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) return undefined;
  let libc = options.libc;
  if (platform === "linux" && !libc) {
    const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header;
    libc = header.glibcVersionRuntime ? "glibc" : "musl";
  }
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  const specifier = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${suffix}/${platform === "win32" ? "claude.exe" : "claude"}`;
  try {
    const resolveModule = options.resolveModule ?? ((name: string) => {
      // Resolve relative to the SDK so pnpm's isolated dependency tree works too.
      return createRequire(require.resolve("@anthropic-ai/claude-agent-sdk")).resolve(name);
    });
    const resolved = resolveModule(specifier);
    // Native executables cannot run inside ASAR. Packaging explicitly unpacks
    // the original binary; do not extract, modify, or download it at runtime.
    const candidate = resolved.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
    return await (options.validatePath ?? (async (file: string) => {
      await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
      return await realpath(file);
    }))(candidate);
  } catch {
    return undefined;
  }
}
