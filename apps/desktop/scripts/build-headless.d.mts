import type { BuildOptions, BuildResult, Plugin } from "esbuild";
export const headlessEntries: Record<string, string>;
export function buildHeadless(options?: {
  outputDirectory?: string;
  plugins?: Plugin[];
  portable?: boolean;
  sourcemap?: BuildOptions["sourcemap"];
  logLevel?: BuildOptions["logLevel"];
}): Promise<BuildResult>;
