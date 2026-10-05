/**
 * Byte figure for operator-facing metadata: whole bytes/KB below 1 MB, then
 * one decimal only while the leading digits are scarce (below 10 of the
 * unit) — "5.2 MB" carries signal, "200.0 MB" is noise.
 *
 * Shared so the federation transfer line and the Star Map load card cannot
 * drift into two different roundings of the same kind of number.
 */
export function formatByteCount(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  const mb = value / (1024 * 1024);
  if (mb < 1024) {
    return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  }
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/**
 * A file's size as the Edits rail prints it: one decimal at every unit, so
 * a re-exported sprite that moved by a few KB reads as changed. The image
 * previews under a row use it too, so the chip and the frame beneath it agree.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes.toLocaleString()} B`;
}
