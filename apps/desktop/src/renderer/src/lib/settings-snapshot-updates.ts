import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";

export function applyConfigUpdateToSettingsSnapshot(
  snapshot: DesktopSettingsSnapshot,
  patch: DesktopSettingsConfigPatch,
): DesktopSettingsSnapshot {
  return mergeConfigPatch(snapshot, patch) as DesktopSettingsSnapshot;
}

export function applySecretUpdateToSettingsSnapshot(
  snapshot: DesktopSettingsSnapshot,
  secret: DesktopSettingsSecretName,
  state: DesktopSettingsSecretState,
): DesktopSettingsSnapshot {
  const path = secretSnapshotPath(secret);
  return path ? replaceNestedValue(snapshot, path, state) : snapshot;
}

function mergeConfigPatch(target: unknown, patch: unknown): unknown {
  if (isSettingsValue(target)) {
    if (target.source === "env") {
      return {
        ...target,
        overriddenByEnv: true,
      };
    }
    const {
      error: _error,
      overriddenByEnv: _overriddenByEnv,
      ...current
    } = target;
    return {
      ...current,
      value: patch === null ? undefined : structuredClone(patch),
      source: patch === null ? "default" : "config",
    };
  }
  if (
    patch === null
    || typeof patch !== "object"
    || Array.isArray(patch)
  ) {
    return patch === null ? undefined : structuredClone(patch);
  }
  const targetRecord = target && typeof target === "object"
    ? target as Record<string, unknown>
    : {};
  return {
    ...targetRecord,
    ...Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).map(([key, value]) => [
        key,
        mergeConfigPatch(targetRecord[key], value),
      ]),
    ),
  };
}

function isSettingsValue(value: unknown): value is Record<string, unknown> & {
  source: string;
  value: unknown;
} {
  return Boolean(
    value
    && typeof value === "object"
    && "source" in value
    && "value" in value,
  );
}

function replaceNestedValue<T>(
  source: T,
  path: readonly string[],
  value: unknown,
): T {
  const [key, ...rest] = path;
  if (!key) return source;
  const record = source && typeof source === "object"
    ? source as Record<string, unknown>
    : {};
  return {
    ...record,
    [key]: rest.length === 0
      ? value
      : replaceNestedValue(record[key], rest, value),
  } as T;
}

function secretSnapshotPath(
  secret: DesktopSettingsSecretName,
): readonly string[] | undefined {
  switch (secret) {
    case "telegramBotToken":
      return ["messaging", "telegram", "botToken"];
    case "discordBotToken":
      return ["messaging", "discord", "botToken"];
    case "mattermostBotToken":
      return ["messaging", "mattermost", "botToken"];
    case "mattermostHmacSecret":
      return ["messaging", "mattermost", "hmacSecret"];
    case "slackBotToken":
      return ["messaging", "slack", "botToken"];
    case "slackAppToken":
      return ["messaging", "slack", "appToken"];
    case "slackSigningSecret":
      return ["messaging", "slack", "signingSecret"];
    case "feishuAppId":
      return ["messaging", "feishu", "appId"];
    case "feishuAppSecret":
      return ["messaging", "feishu", "appSecret"];
    case "feishuEncryptKey":
      return ["messaging", "feishu", "encryptKey"];
    case "feishuVerificationToken":
      return ["messaging", "feishu", "verificationToken"];
    case "lineChannelAccessToken":
      return ["messaging", "line", "channelAccessToken"];
    case "lineChannelSecret":
      return ["messaging", "line", "channelSecret"];
    case "federationInstancePrivateKey":
      return ["federation", "instancePrivateKey"];
    case "federationNoiseStaticPrivateKey":
      return ["federation", "noiseStaticPrivateKey"];
    case "federationCloudflareClientCertificate":
      return ["federation", "cloudflareClientCertificate"];
    case "federationCloudflareClientPrivateKey":
      return ["federation", "cloudflareClientPrivateKey"];
    case "federationCloudflareAccessClientId":
      return ["federation", "cloudflareAccessClientId"];
    case "federationCloudflareAccessClientSecret":
      return ["federation", "cloudflareAccessClientSecret"];
    case "pwrsnapMcpCredential":
    case "pwrgitMcpCredential":
      return undefined;
  }
}
