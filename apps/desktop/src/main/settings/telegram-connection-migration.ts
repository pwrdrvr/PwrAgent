import type { DesktopTelegramConnection, TelegramConnectionSecretName } from "@pwragent/shared/contracts/settings";
import { validateTelegramPositiveId } from "@pwragent/shared/messaging-id-validation";
import { telegramConnectionSecretName } from "./telegram-connections-config";

type TelegramConnectionCandidate = Omit<DesktopTelegramConnection, "botAccountId"> & { token: string };

type TelegramConnectionMigrationPorts = {
  verify(token: string): Promise<string | undefined>;
  writeSecret(name: TelegramConnectionSecretName, token: string): Promise<void>;
  publish(connections: DesktopTelegramConnection[]): Promise<void>;
};

/** First save is retryable: staged secrets have no runtime audience until the config commit. */
export async function publishTelegramConnection(
  current: readonly DesktopTelegramConnection[],
  candidate: TelegramConnectionCandidate,
  legacy: TelegramConnectionCandidate | undefined,
  ports: TelegramConnectionMigrationPorts,
): Promise<DesktopTelegramConnection> {
  if (legacy && current.length !== 0) throw new Error("Telegram connections have already been configured.");
  const verify = async ({ token, ...fields }: TelegramConnectionCandidate): Promise<DesktopTelegramConnection> => {
    telegramConnectionSecretName(fields.id);
    const botAccountId = await ports.verify(token);
    if (!botAccountId || !validateTelegramPositiveId(botAccountId).ok) {
      throw new Error("Telegram could not verify this bot. Check the token and try again.");
    }
    return { ...fields, botAccountId };
  };
  const namedConnection = await verify(candidate);
  const legacyConnection = legacy ? await verify(legacy) : undefined;
  const existing = legacyConnection ? [...current, legacyConnection] : current;
  if (existing.some((connection) => connection.id === namedConnection.id || connection.botAccountId === namedConnection.botAccountId)) {
    throw new Error("This Telegram bot is already connected to this profile.");
  }

  if (legacy) await ports.writeSecret(telegramConnectionSecretName(legacy.id), legacy.token);
  await ports.writeSecret(telegramConnectionSecretName(candidate.id), candidate.token);
  await ports.publish([...existing, namedConnection]);
  return namedConnection;
}
