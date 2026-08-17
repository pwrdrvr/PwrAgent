/**
 * Discovery failure reasons arrive from the main process in two very
 * different shapes: short classified tokens like `not_found`, and raw spawn
 * errors that are whole command lines —
 *
 *   Command failed: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe
 *   -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File …
 *
 * `.settings-pathrow__chips` is `flex: 0 0 auto`, so a chip carrying that
 * second shape does not wrap or ellipsize — it takes the width it wants and
 * squeezes the sibling path down to "C:". Every caller must therefore render
 * `describeCommandDiscoveryFailure` in the chip and keep the raw text for
 * `commandDiscoveryFailureDetail`, which feeds the row's mono detail line.
 */

const CLASSIFIED_FAILURE_LABELS: Record<string, string> = {
  codex_too_old: "Codex too old",
  not_executable: "Not executable",
  not_found: "Missing",
  powershell_shim_unsupported: "PowerShell shim",
  version_not_reported: "Version unknown",
};

export function isClassifiedCommandDiscoveryFailure(reason: string): boolean {
  return Object.hasOwn(CLASSIFIED_FAILURE_LABELS, reason);
}

/**
 * Chip-sized label for a discovery failure. Never returns the raw reason.
 *
 * `extra` lets a caller add domain-specific tokens (Git's Xcode-license
 * probe) without every surface learning about them.
 */
export function describeCommandDiscoveryFailure(
  reason?: string,
  extra?: (reason: string) => string | undefined,
): string | undefined {
  if (!reason) return undefined;
  const classified = CLASSIFIED_FAILURE_LABELS[reason];
  if (classified) return classified;
  const domain = extra?.(reason);
  if (domain) return domain;
  if (/\b(EPERM|EACCES)\b/.test(reason)) return "Blocked";
  if (/\bETIMEDOUT\b/.test(reason) || /timed?\s?out/i.test(reason)) {
    return "Timed out";
  }
  if (/\b(ENOENT|ENOTDIR)\b/.test(reason)) return "Missing";
  return "Launch failed";
}

/**
 * The raw reason, but only when it carries information the chip label lost.
 * A classified token is already fully described by its label, so returning it
 * here would just repeat the chip on the detail line.
 */
export function commandDiscoveryFailureDetail(
  reason?: string,
  extra?: (reason: string) => string | undefined,
): string | undefined {
  if (!reason) return undefined;
  if (isClassifiedCommandDiscoveryFailure(reason) || extra?.(reason)) {
    return undefined;
  }
  return reason;
}
