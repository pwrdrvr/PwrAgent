import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { claudeSetupStatus } from "./harness-setup-status";
import type { SettingsChipTone } from "./SettingsLayout";

type ClaudeInstallation = BackendSummary["claude"];

/**
 * The one reading of Claude's setup state. The Settings nav, the AI Providers
 * list, the Claude pane, and the thread's AI providers panel all render from
 * this, so they cannot describe the same installation in different words or
 * tones. It is the headline of `claudeSetupStatus`, which also carries the
 * ordered setup steps.
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
  const { label, tone, dot, navChip } = claudeSetupStatus(installation);
  return { label, tone, dot, ...(navChip ? { navChip } : {}) };
}
