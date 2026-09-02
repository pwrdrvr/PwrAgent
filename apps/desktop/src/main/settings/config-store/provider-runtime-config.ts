import type {
  ConfigDomainMap,
  ProviderProjection,
} from "./config-domains";
import {
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  ACP_AGENTS_GROK_CLI_PATH_ENV,
  ACP_AGENTS_KIMI_CLI_PATH_ENV,
  ACP_AGENTS_QWEN_CLI_PATH_ENV,
} from "../desktop-settings-env";

const ACP_CLI_PATH_ENV_BY_ID: Readonly<Record<string, string>> = {
  gemini: ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  grok: ACP_AGENTS_GROK_CLI_PATH_ENV,
  kimi: ACP_AGENTS_KIMI_CLI_PATH_ENV,
  qwen: ACP_AGENTS_QWEN_CLI_PATH_ENV,
};

export function providerProjectionForRegistryId(
  providers: ConfigDomainMap["providers"],
  registryId: string,
): ProviderProjection | undefined {
  return (providers as Readonly<Record<string, ProviderProjection>>)[registryId];
}

export function acpProviderEnabledFromSnapshot(
  providers: ConfigDomainMap["providers"],
  registryId: string,
): boolean {
  return providerProjectionForRegistryId(providers, registryId)
    ?.configured.enabled !== false;
}

export function acpProviderCommandOverrideFromSnapshot(
  providers: ConfigDomainMap["providers"],
  registryId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envKey = ACP_CLI_PATH_ENV_BY_ID[registryId];
  const envOverride = envKey ? env[envKey]?.trim() || undefined : undefined;
  if (envOverride) {
    return envOverride;
  }
  return providerProjectionForRegistryId(providers, registryId)
    ?.configured.commandOverride;
}

export function managedGrokBuildsEnabledFromSnapshot(
  providers: ConfigDomainMap["providers"],
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): boolean {
  const grok = providerProjectionForRegistryId(providers, "grok");
  if (grok?.configured.enabled === false) {
    return false;
  }
  if (!isPackaged && env.PWRAGENT_E2E === "1") {
    return false;
  }
  return grok?.configured.managedBuilds ?? !isPackaged;
}
