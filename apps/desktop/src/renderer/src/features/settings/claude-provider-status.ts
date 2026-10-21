import type { BackendSummary } from "@pwragent/shared";
import type { SettingsChipTone } from "./SettingsLayout";

type ClaudeInstallation = BackendSummary["claude"];

/**
 * The one reading of Claude's setup state. The Settings nav, the AI Providers
 * list, and the Claude pane all render from this, so the three cannot
 * describe the same installation in different words or tones.
 */
export type ClaudeProviderStatus = {
  /** Sentence-case label for the provider list chip and the pane's status. */
  label: string;
  tone: SettingsChipTone;
  /** Nav dot. Grey while unknown, so the row never looks broken. */
  dot: "ok" | "off" | "warn";
  /** Lower-case nav chip; only for states that need the operator. */
  navChip?: string;
};

export function claudeProviderStatus(
  installation: ClaudeInstallation | undefined,
): ClaudeProviderStatus {
  if (!installation) {
    return { label: "Not checked", tone: "muted", dot: "off" };
  }
  if (!installation.executable) {
    return { label: "Not installed", tone: "muted", dot: "off", navChip: "not installed" };
  }
  if (installation.authStatus === "sign-in-required") {
    return { label: "Sign-in required", tone: "warn", dot: "warn", navChip: "sign in" };
  }
  if (installation.authStatus !== "signed-in") {
    return { label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" };
  }
  return {
    label: installation.authMethod === "api-key" ? "API key" : "Signed in",
    tone: "ok",
    dot: "ok",
  };
}
