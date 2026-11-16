export type MathExportColor = "dark" | "light" | "theme";
export type MathExportScale = 1 | 2 | 4;
export type MathExportOptions = { color: MathExportColor; scale: MathExportScale };

export const DEFAULT_MATH_EXPORT_OPTIONS: MathExportOptions = { color: "dark", scale: 2 };
export const MATH_EXPORT_COLOR_LABELS: Record<MathExportColor, string> = {
  dark: "Dark", light: "Light", theme: "App theme",
};
const STORAGE_KEY = "pwragent.math.exportOptions";

export function parseMathExportOptions(value: unknown): MathExportOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_MATH_EXPORT_OPTIONS };
  const stored = value as Record<string, unknown>;
  return {
    color: stored.color === "dark" || stored.color === "light" || stored.color === "theme"
      ? stored.color : DEFAULT_MATH_EXPORT_OPTIONS.color,
    scale: stored.scale === 1 || stored.scale === 2 || stored.scale === 4
      ? stored.scale : DEFAULT_MATH_EXPORT_OPTIONS.scale,
  };
}

// Local viewing/export preferences, like the Star Map's view choices. Read on
// menu open: no per-formula subscriptions or writes during transcript renders.
export function readMathExportOptions(): MathExportOptions {
  try { return parseMathExportOptions(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")); }
  catch { return { ...DEFAULT_MATH_EXPORT_OPTIONS }; }
}

export function writeMathExportOptions(options: MathExportOptions): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parseMathExportOptions(options))); }
  catch { /* Export remains available when local preference storage is blocked. */ }
}
