/** Conservative candidate detection; existence is always checked by the owner. */
export function transcriptFileReference(reference: string): {
  path: string;
  line?: number;
  column?: number;
} | undefined {
  if (!reference || reference.length > 4096 || reference !== reference.trim()
    || /[\n\r\0<>"|?*`$]/.test(reference)) return undefined;
  const suffix = /:(\d+)(?::(\d+))?$/.exec(reference);
  const filePath = suffix ? reference.slice(0, suffix.index) : reference;
  // Exclude URLs, commands, expressions, and bare identifiers such as PATH.
  if (/^[a-z][a-z\d+.-]*:/i.test(filePath) && !/^[a-z]:[\\/]/i.test(filePath)) return undefined;
  if (/[;=(){}]/.test(filePath)) return undefined;
  const name = filePath.split(/[\\/]/).at(-1) ?? "";
  if (!name || name === "." || name === "..") return undefined;
  if (!/[\\/]/.test(filePath)
    && !/^[\w .%#+-]+\.[a-z\d_-]+$/i.test(name)
    && !/^(?:README|LICENSE|NOTICE|Dockerfile|Makefile|\.gitignore)$/i.test(name)) return undefined;
  const line = suffix ? Number(suffix[1]) : undefined;
  const column = suffix?.[2] ? Number(suffix[2]) : undefined;
  if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1))
    || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return undefined;
  return { path: filePath, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
}
