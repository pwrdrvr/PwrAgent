export const bytecodeBudget: number;
export function wrapVitestModule(code: string): string;
export type BytecodeModule = { file: string; variant: string; code: string; esm?: boolean };
export type BytecodeRecord = { file: string; variant: string; name: string; bytes: number; positions: number[] };
export function compileBytecode(modules: BytecodeModule[], options?: { executable?: string; env?: Record<string, string> }): Promise<{ runtime: Record<string, string>; records: BytecodeRecord[] }>;
