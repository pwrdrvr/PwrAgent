export const rendererBytecodeBudget: number;
export const rendererBytecodeRoots: ReadonlyArray<readonly [name: string, file: string]>;
export function discoverRendererBytecodeSources(
  root: string,
  roots: readonly string[],
  boundaries: readonly string[],
): string[];
