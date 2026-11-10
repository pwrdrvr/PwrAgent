export const RULE: string;
export function findElectronDependencies(entryPoints: string[], repoRoot: string): Promise<Array<{ path: string; module: string }>>;
