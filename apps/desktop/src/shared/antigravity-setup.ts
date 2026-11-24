export type AntigravityRuntimeStatus =
  | { status: "unsupported" | "not-installed" }
  | { status: "installed"; runtime: { command: string; version: string } };

/** What Google's release manifest served when PwrAgent last asked. */
export type AntigravityReleaseStatus = { latestVersion: string; checkedAt: number };

/**
 * Numeric comparison of two `MAJOR.MINOR.PATCH` Antigravity versions: negative
 * when `left` is older, positive when newer. The installer's "keep the newer
 * active release" rule and every "update available" decision share this one
 * comparator, so they cannot disagree about which build is newer.
 */
export function compareAntigravityVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = BigInt(leftParts[index] ?? "0") - BigInt(rightParts[index] ?? "0");
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

export type AntigravitySetupRequest =
  | { action: "read" | "install" | "install-guide" }
  /** Ask Google's manifest for the current release. Without `force`, an
   *  answer from the last few minutes is reused. */
  | { action: "check-update"; force?: boolean }
  | { action: "start" | "wait" | "cancel" | "reopen" | "copy-link"; attemptId: string }
  | { action: "submit"; attemptId: string; code: string };

export type AntigravitySetupResult =
  | { ok: false; message: string }
  | {
      ok: true;
      runtime?: AntigravityRuntimeStatus;
      /** Present after `check-update` on a platform PwrAgent can install on,
       *  unless update checks are turned off for this run. */
      release?: AntigravityReleaseStatus;
      expiresAt?: number;
      verifiedCommand?: string;
    };
