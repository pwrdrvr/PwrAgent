import type { Plugin } from "esbuild";
export const headlessEntries: Record<string, string>;
export function buildHeadless(options?: { outputDirectory?: string; plugins?: Plugin[] }): Promise<void>;
