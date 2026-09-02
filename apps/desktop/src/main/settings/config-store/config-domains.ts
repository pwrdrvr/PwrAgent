import { createHash } from "node:crypto";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopOnboardingCompletedSource,
  DesktopSpendAlertPolicy,
  DesktopSettingsSecretName,
  DesktopTextSize,
  DesktopToolOutputAlertPolicy,
  PrAutoDispatchBudgetConfig,
} from "@pwragent/shared";
import {
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_SPEND_ALERT_POLICY_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
  MAX_REPEATED_LARGE_OUTPUT_CALLS,
  MAX_REPEATED_LARGE_OUTPUT_PERCENT,
  MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  MAX_SPEND_ALERT_THRESHOLD_USD,
  MIN_REPEATED_LARGE_OUTPUT_CALLS,
  MIN_REPEATED_LARGE_OUTPUT_PERCENT,
  MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  MIN_SPEND_ALERT_THRESHOLD_USD,
} from "@pwragent/shared";
import type { DesktopSettingsConfig } from "../desktop-config";

export const CONFIG_STORE_DURABLE_SCHEMA_VERSION = 1;
export const PROVIDER_IDS = ["codex", "gemini", "grok", "kimi", "qwen"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

type ConfigSection<K extends keyof DesktopSettingsConfig> = Readonly<
  NonNullable<DesktopSettingsConfig[K]>
>;

export type NormalizedGeneralConfig = Readonly<{
  appearance: Readonly<{
    theme: DesktopAppearanceTheme;
    density: DesktopAppearanceDensity;
    sidebarTextSize: DesktopTextSize;
    transcriptTextSize: DesktopTextSize;
  }>;
  settings: ConfigSection<"general">;
}>;

export type NormalizedOnboardingConfig = Readonly<{
  completed: boolean;
  completedSource: DesktopOnboardingCompletedSource | "";
}>;

export type ProviderCandidateSummary = Readonly<{
  command: string;
  version?: string;
  source: string;
  failureReason?: string;
}>;

export type ProviderProjection = Readonly<{
  provider: ProviderId;
  dependencyFingerprint: string;
  configured: Readonly<{
    enabled: boolean;
    commandOverride?: string;
    managedBuilds?: boolean;
  }>;
  lastKnownGood?: Readonly<{
    /** Configuration dependency fingerprint this observation verified. Older
     * durable rows omit it and are normalized from their enclosing row. */
    dependencyFingerprint?: string;
    selectedCommand?: string;
    selectedVersion?: string;
    candidates: readonly ProviderCandidateSummary[];
    executableIdentity?: Readonly<{
      realpath: string;
      size: number;
      mtimeMs: number;
    }>;
    validatedAt: number;
  }>;
  validation: Readonly<{
    state: "unknown" | "checking" | "valid" | "failed" | "stale";
    lastAttemptAt?: number;
    error?: string;
  }>;
}>;

export type SecretPresence = Readonly<{
  configured: boolean;
  source: "env" | "keychain" | "unset";
  writable: boolean;
  unavailableReason?: string;
}>;

export type ConfigDomainMap = Readonly<{
  general: NormalizedGeneralConfig;
  onboarding: NormalizedOnboardingConfig;
  experimental: ConfigSection<"experimental">;
  messaging: ConfigSection<"messaging">;
  federation: ConfigSection<"federation">;
  models: ConfigSection<"models">;
  providers: Readonly<Record<ProviderId, ProviderProjection>>;
  applications: ConfigSection<"applications">;
  git: ConfigSection<"git">;
  updates: ConfigSection<"updates">;
  worktrees: ConfigSection<"worktrees">;
  ui: ConfigSection<"ui">;
  integratedTerminal: ConfigSection<"integratedTerminal">;
  imageUploads: ConfigSection<"imageUploads">;
}>;

export const CONFIG_DOMAIN_KEYS = [
  "general",
  "onboarding",
  "experimental",
  "messaging",
  "federation",
  "models",
  "providers",
  "applications",
  "git",
  "updates",
  "worktrees",
  "ui",
  "integratedTerminal",
  "imageUploads",
] as const satisfies readonly (keyof ConfigDomainMap)[];

export type ConfigFileStatus =
  | Readonly<{ kind: "valid"; contentHash: string; observedAt: number }>
  | Readonly<{ kind: "missing"; observedAt: number }>
  | Readonly<{
      kind: "invalid";
      contentHash: string;
      error: string;
      observedAt: number;
      serving: "last-known-good" | "defaults";
    }>;

export type ConfigStoreSnapshot = Readonly<{
  version: number;
  durableSchemaVersion: number;
  configFile: ConfigFileStatus;
  configRevision: string;
  domains: ConfigDomainMap;
  secretPresence: Readonly<
    Partial<Record<DesktopSettingsSecretName, SecretPresence>>
  >;
}>;

export function normalizeConfigDomains(params: {
  config: DesktopSettingsConfig;
  previousProviders?: Readonly<Record<ProviderId, ProviderProjection>>;
}): ConfigDomainMap {
  const config = structuredClone(params.config);
  const completed = config.onboarding?.completed;
  const completedSource = config.onboarding?.completedSource;
  const inferredMigrated = completed === undefined && completedSource === undefined;
  const providers = Object.fromEntries(
    PROVIDER_IDS.map((provider) => {
      const commandOverride = provider === "codex"
        ? config.models?.codex?.path?.trim() || undefined
        : config.acpAgents?.[provider]?.cliPath?.trim() || undefined;
      const enabled = provider === "codex"
        ? true
        : config.acpAgents?.[provider]?.enabled !== false;
      const dependencyFingerprint = providerDependencyFingerprint({
        commandOverride,
        enabled,
        managedBuilds:
          provider === "grok"
            ? config.acpAgents?.grok?.managedBuilds
            : undefined,
        provider,
      });
      const previous = params.previousProviders?.[provider];
      const projection: ProviderProjection = {
        provider,
        dependencyFingerprint,
        configured: {
          enabled,
          ...(commandOverride ? { commandOverride } : {}),
          ...(provider === "grok"
            && config.acpAgents?.grok?.managedBuilds !== undefined
            ? { managedBuilds: config.acpAgents.grok.managedBuilds }
            : {}),
        },
        ...(previous?.lastKnownGood
          ? {
              lastKnownGood: {
                ...previous.lastKnownGood,
                dependencyFingerprint:
                  previous.lastKnownGood.dependencyFingerprint
                  ?? previous.dependencyFingerprint,
              },
            }
          : {}),
        validation:
          previous?.dependencyFingerprint === dependencyFingerprint
            ? previous.validation
            : {
                state: previous?.lastKnownGood ? "stale" : "unknown",
              },
      };
      return [provider, projection];
    }),
  ) as Record<ProviderId, ProviderProjection>;

  return deepFreeze({
    general: {
      appearance: {
        theme:
          config.general?.appearance?.theme
          ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
        density:
          config.general?.appearance?.density
          ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
        sidebarTextSize:
          config.general?.appearance?.sidebarTextSize
          ?? DESKTOP_TEXT_SIZE_DEFAULT,
        transcriptTextSize:
          config.general?.appearance?.transcriptTextSize
          ?? DESKTOP_TEXT_SIZE_DEFAULT,
      },
      settings: config.general ?? {},
    },
    onboarding: {
      completed: completed ?? inferredMigrated,
      completedSource:
        completedSource ?? (inferredMigrated ? "migrated" : ""),
    },
    experimental: config.experimental ?? {},
    messaging: config.messaging ?? {},
    federation: config.federation ?? {},
    models: config.models ?? {},
    providers,
    applications: config.applications ?? {},
    git: config.git ?? {},
    updates: config.updates ?? {},
    worktrees: config.worktrees ?? {},
    ui: config.ui ?? {},
    integratedTerminal: config.integratedTerminal ?? {},
    imageUploads: config.imageUploads ?? {},
  });
}

export function providerLastKnownGoodMatchesConfig(
  provider: ProviderProjection,
): boolean {
  const lastKnownGood = provider.lastKnownGood;
  if (!lastKnownGood) return false;
  return (
    lastKnownGood.dependencyFingerprint ?? provider.dependencyFingerprint
  ) === provider.dependencyFingerprint
    && provider.validation.state !== "stale";
}

export function providerDependencyFingerprint(params: {
  commandOverride?: string;
  enabled: boolean;
  managedBuilds?: boolean;
  provider: ProviderId;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      arch: process.arch,
      commandOverride: params.commandOverride ?? "",
      enabled: params.enabled,
      managedBuilds: params.managedBuilds ?? null,
      platform: process.platform,
      provider: params.provider,
      schemaVersion: CONFIG_STORE_DURABLE_SCHEMA_VERSION,
    }))
    .digest("hex");
}

export function resolveToolOutputAlertPolicy(
  general: NormalizedGeneralConfig,
): DesktopToolOutputAlertPolicy {
  const config = general.settings.toolOutputAlerts;
  return {
    outputCapHitsEnabled:
      config?.outputCapHitsEnabled
      ?? DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.outputCapHitsEnabled,
    repeatedLargeOutputsEnabled:
      config?.repeatedLargeOutputsEnabled
      ?? DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputsEnabled,
    repeatedLargeOutputMinimumCalls: boundedInteger(
      config?.repeatedLargeOutputMinimumCalls,
      DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputMinimumCalls,
      MIN_REPEATED_LARGE_OUTPUT_CALLS,
      MAX_REPEATED_LARGE_OUTPUT_CALLS,
    ),
    repeatedLargeOutputMinimumPercent: boundedInteger(
      config?.repeatedLargeOutputMinimumPercent,
      DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputMinimumPercent,
      MIN_REPEATED_LARGE_OUTPUT_PERCENT,
      MAX_REPEATED_LARGE_OUTPUT_PERCENT,
    ),
    repeatedQueuedChecksEnabled:
      config?.repeatedQueuedChecksEnabled
      ?? DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedQueuedChecksEnabled,
  };
}

export function resolveSpendAlertPolicy(
  general: NormalizedGeneralConfig,
): DesktopSpendAlertPolicy {
  const config = general.settings.spendAlerts;
  return {
    activeTurnSpendEnabled:
      config?.activeTurnSpendEnabled
      ?? DESKTOP_SPEND_ALERT_POLICY_DEFAULT.activeTurnSpendEnabled,
    activeTurnSpendThresholdUsd: boundedAmount(
      config?.activeTurnSpendThresholdUsd,
      DESKTOP_SPEND_ALERT_POLICY_DEFAULT.activeTurnSpendThresholdUsd,
    ),
    threadSpendEnabled:
      config?.threadSpendEnabled
      ?? DESKTOP_SPEND_ALERT_POLICY_DEFAULT.threadSpendEnabled,
    threadSpendThresholdUsd: boundedAmount(
      config?.threadSpendThresholdUsd,
      DESKTOP_SPEND_ALERT_POLICY_DEFAULT.threadSpendThresholdUsd,
    ),
  };
}

export type PrAutomationConfig = Readonly<{
  backgroundPollingEnabled: boolean;
  prAutoDispatchAllowed: boolean;
  budget: PrAutoDispatchBudgetConfig;
}>;

export function resolvePrAutomationConfig(
  git: ConfigDomainMap["git"],
): PrAutomationConfig {
  return {
    backgroundPollingEnabled:
      git.backgroundPrPolling ?? DEFAULT_BACKGROUND_PR_POLLING,
    prAutoDispatchAllowed:
      git.prAutoDispatchAllowed ?? DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
    budget: {
      capacity: boundedFloor(
        git.prAutoDispatchBudgetCapacity,
        DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
        MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
        MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
      ),
      refillPerMinute: boundedFloor(
        git.prAutoDispatchBudgetRefillPerMinute,
        DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
        MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
        MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
      ),
      pauseWhenEmpty:
        git.pausePrAutoDispatchWhenBudgetEmpty
        ?? DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
    },
  };
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : defaultValue;
}

function boundedAmount(
  value: number | undefined,
  defaultValue: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(
        MAX_SPEND_ALERT_THRESHOLD_USD,
        Math.max(
          MIN_SPEND_ALERT_THRESHOLD_USD,
          Math.round(value * 100) / 100,
        ),
      )
    : defaultValue;
}

function boundedFloor(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : defaultValue;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
