import type {
  DesktopAuthorizedContact,
  DesktopSettingsValue,
} from "@pwragent/shared";

export function formatSourceLabel(source: string, overriddenByEnv?: boolean): string {
  if (source === "env") {
    return "env";
  }
  if (source === "keychain") {
    return overriddenByEnv ? "env override" : "keychain";
  }
  if (source === "config") {
    return overriddenByEnv ? "env override" : "config";
  }
  return source;
}

export function joinListValue(value: string[]): string {
  return value.join(", ");
}

export function parseListValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sourceBadge<T>(setting: DesktopSettingsValue<T>): string {
  return formatSourceLabel(setting.source, setting.overriddenByEnv);
}

export function optionalStringSourceBadge(
  setting: DesktopSettingsValue<string>,
): string {
  if (setting.source === "default" && !setting.value.trim()) {
    return "unset";
  }

  return sourceBadge(setting);
}

export function optionalListSourceBadge(
  setting: DesktopSettingsValue<string[] | DesktopAuthorizedContact[]>,
): string {
  if (setting.source === "default" && setting.value.length === 0) {
    return "unset";
  }

  return sourceBadge(setting);
}
