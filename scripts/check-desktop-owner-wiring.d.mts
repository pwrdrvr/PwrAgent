export interface OwnerWiringFinding {
  method: string;
  line: number;
  column: number;
}
export const RULE: string;
export function findOwnerWiring(source: string, filename: string): OwnerWiringFinding[];
export interface OwnerImportFinding {
  rule: string;
  module: string;
  line: number;
  column: number;
}
export function findOwnerImports(source: string, filename: string): OwnerImportFinding[];
export function checkOwnerWiring(repoRoot: string): Array<(OwnerWiringFinding | OwnerImportFinding) & { path: string }>;
