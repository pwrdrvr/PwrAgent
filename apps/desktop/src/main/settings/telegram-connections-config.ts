import { randomUUID } from "node:crypto";
import type { DesktopTelegramConnection, TelegramConnectionSecretName } from "@pwragent/shared/contracts/settings";
import { validateTelegramGroupChatId, validateTelegramPositiveId } from "@pwragent/shared/messaging-id-validation";

export function createTelegramConnectionId(): string {
  return `mc_${randomUUID().replaceAll("-", "")}`;
}

export function telegramConnectionSecretName(id: string): TelegramConnectionSecretName {
  if (!/^mc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid Telegram connection ID.");
  return `telegramBotToken:${id}`;
}

export function parseTelegramConnections(value: unknown): DesktopTelegramConnection[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2) return null;

  const ids = new Set<string>();
  const accounts = new Set<string>();
  const connections: DesktopTelegramConnection[] = [];
  let legacySeen = false;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const id = row.id;
    const account = row.bot_account_id;
    const displayName = typeof row.display_name === "string" ? row.display_name.trim() : "";
    const legacy = row.legacy === true;
    if (typeof id !== "string" || !/^mc_[a-f0-9]{32}$/.test(id)
      || typeof account !== "string" || !validateTelegramPositiveId(account).ok
      || !displayName || displayName.length > 100 || typeof row.enabled !== "boolean"
      || (row.legacy !== undefined && typeof row.legacy !== "boolean")
      || ids.has(id) || accounts.has(account) || (legacy && legacySeen)) return null;

    const users = row.authorized_user_ids ?? [];
    const groups = row.authorized_supergroup_ids ?? [];
    if (!Array.isArray(users) || !users.every((user): user is string => typeof user === "string" && validateTelegramPositiveId(user).ok)
      || !Array.isArray(groups) || !groups.every((group): group is string => typeof group === "string" && validateTelegramGroupChatId(group).ok)) return null;

    ids.add(id);
    accounts.add(account);
    legacySeen ||= legacy;
    connections.push({
      id, displayName, botAccountId: account, enabled: row.enabled, legacy,
      authorizedUserIds: [...new Set(users)],
      authorizedSupergroupIds: [...new Set(groups)],
    });
  }
  return connections;
}

export function telegramConnectionConfigRows(connections: readonly DesktopTelegramConnection[]) {
  return connections.map((connection) => ({
    id: connection.id,
    display_name: connection.displayName,
    bot_account_id: connection.botAccountId,
    enabled: connection.enabled,
    legacy: connection.legacy,
    authorized_user_ids: connection.authorizedUserIds,
    authorized_supergroup_ids: connection.authorizedSupergroupIds,
  }));
}
