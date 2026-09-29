/**
 * Display text for an error raised by a composer action.
 *
 * The raw string is what the operator copies. What they read is the same
 * message without Electron's IPC wrapper and without the PowerShell progress
 * stream (CLIXML) that Windows environment commands leave on stderr.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:Error: )?/;
const HANDLER_PREFIX = /^handler_failed:\s*/;
const POWERSHELL_PROGRESS = /(?:#< CLIXML\s*)?<Objs\b[\s\S]*?<\/Objs>/g;

/** Past this length a one-line summary is assumed to truncate in the row. */
const SUMMARY_MAX_LENGTH = 90;

export function cleanComposerErrorMessage(raw: string): string {
  return raw
    .replace(IPC_WRAPPER, "")
    .replace(HANDLER_PREFIX, "")
    .replace(POWERSHELL_PROGRESS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function summarizeComposerError(raw: string): {
  /** The first line, which is all the collapsed row shows. */
  summary: string;
  /** The whole cleaned message when the summary alone would lose part of it. */
  detail?: string;
} {
  const cleaned = cleanComposerErrorMessage(raw) || raw.trim();
  const [first = "", ...rest] = cleaned.split("\n");
  // A trailing colon introduces the lines below, which the row does not show.
  const summary = first.trim().replace(/:$/, "");
  const hasMore = rest.some((line) => line.trim()) || summary.length > SUMMARY_MAX_LENGTH;
  return hasMore ? { summary, detail: cleaned } : { summary };
}
