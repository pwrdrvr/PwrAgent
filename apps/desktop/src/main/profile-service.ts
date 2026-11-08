import type { DesktopBootInfo } from "@pwragent/shared";
import { assertUnreachableProfileBootDecision, resolveActiveProfileName } from "./profile";
import { getAppStateMode, getBootDecision } from "./storage/desktop-runtime-storage";

export function isBootstrapProfile(): boolean {
  return getAppStateMode() === "bootstrap";
}

/**
 * Build the `DesktopBootInfo` snapshot for the renderer. Mirrors
 * `getBootDecision()` (set once at startup by index.ts) into a
 * shape the wizard can use to pick its entry mode. Specifically:
 *
 *   - `mode: "bootstrap"` means the wizard is running against the
 *     throwaway `.bootstrap/` profile and its Finish path must
 *     graduate to a real profile (see `graduateBootstrapConfigToProfile`).
 *   - `decisionKind: "missing-named-profile"` + `requestedProfileName`
 *     means the operator launched with `--profile=foo` or
 *     `PWRAGENT_PROFILE=foo` and `foo` doesn't exist. The wizard
 *     pre-populates that name and shows a "set up `foo`?" prompt.
 *
 * If app-state was reset (e.g. tests) and the boot decision is
 * unrecorded, this falls back to a safe "active-profile, open"
 * shape so the wizard's "first-run mode" code path still works.
 */
export function buildBootInfo(): DesktopBootInfo {
  const mode = getAppStateMode() ?? "active-profile";
  const decision = getBootDecision();
  // In active-profile mode the active profile name is the wizard's
  // target for buffered-secret graduation when the operator picks
  // Shared mode (or runs via Help → Replay Onboarding) — no new
  // profile gets created, so we write secrets straight to the
  // profile the renderer is already bound to. In bootstrap mode
  // this stays undefined; the wizard picks per-profile targets
  // through the Multiple/Isolated naming step instead.
  const activeProfileName =
    mode === "active-profile" ? resolveActiveProfileName() : undefined;

  if (!decision) {
    return {
      mode,
      decisionKind: "open",
      ...(activeProfileName ? { activeProfileName } : {}),
    };
  }

  switch (decision.kind) {
    case "open":
      return {
        mode,
        decisionKind: "open",
        ...(activeProfileName ? { activeProfileName } : {}),
      };
    case "missing-named-profile":
      return {
        mode,
        decisionKind: "missing-named-profile",
        requestedProfileName: decision.requestedName,
      };
    case "missing-default-profile":
      return {
        mode,
        decisionKind: "missing-default-profile",
        configuredDefaultName: decision.configuredName,
      };
    case "no-profile-configured":
      return { mode, decisionKind: "no-profile-configured" };
    default:
      // See note on `assertUnreachableProfileBootDecision`. Adding
      // a new ProfileBootDecision variant without extending
      // `DesktopBootInfo['decisionKind']` is a compile error here.
      return assertUnreachableProfileBootDecision(decision);
  }
}

