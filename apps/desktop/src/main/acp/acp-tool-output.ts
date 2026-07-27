import { stripVTControlCharacters } from "node:util";

export function sanitizeAcpToolOutput(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : stripVTControlCharacters(value);
}
