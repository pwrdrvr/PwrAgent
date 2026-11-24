import type { TelegramConnectionStatus } from "@pwragent/shared/contracts/settings";
import type { SelectOption } from "../../components/Select";

/**
 * The Bot picker's value for the original Telegram route. A conversation saved
 * with it omits `connectionId`, so it keeps the singleton route's keys and an
 * older PwrAgent still reads it.
 */
export const ORIGINAL_TELEGRAM_BOT = "";

export type TelegramBotChoice = {
  /** `ORIGINAL_TELEGRAM_BOT`, or a named connection's exact ID. */
  value: string;
  name: string;
  /** Why the bot cannot carry this automation's messages right now. */
  unavailable?: "removed" | "disabled";
  /** Enabled, but not connected to Telegram at the moment. */
  offline?: boolean;
};

export function telegramBotValue(connectionId: string | undefined): string {
  return connectionId ?? ORIGINAL_TELEGRAM_BOT;
}

export function telegramConnectionId(value: string): string | undefined {
  return value === ORIGINAL_TELEGRAM_BOT ? undefined : value;
}

/**
 * Every bot the pickers offer, plus every bot a saved conversation names.
 *
 * A saved conversation keeps its bot. A removed or disabled one is listed as
 * unavailable and stays selected; it is never swapped for the original route,
 * because that would send another bot's messages through this automation.
 *
 * `connections` is undefined until Settings answers. Before then a saved named
 * bot cannot be judged, so it is listed without a verdict.
 */
export function telegramBotChoices(
  connections: readonly TelegramConnectionStatus[] | undefined,
  selected: readonly (string | undefined)[],
): TelegramBotChoice[] {
  const choices: TelegramBotChoice[] = [];
  const legacy = connections?.find((connection) => connection.legacy);
  const named = connections?.filter((connection) => !connection.legacy) ?? [];
  if (legacy) {
    choices.push(choiceFor(ORIGINAL_TELEGRAM_BOT, legacy));
  } else if (connections === undefined || named.length === 0) {
    // No named bot yet: the profile's one bot is the original route.
    choices.push({ value: ORIGINAL_TELEGRAM_BOT, name: "Telegram" });
  } else if (selected.includes(undefined)) {
    // Named bots only, and something saved still points at the original route.
    choices.push({ value: ORIGINAL_TELEGRAM_BOT, name: "Original bot", unavailable: "removed" });
  }
  for (const connection of named) choices.push(choiceFor(connection.id, connection));
  for (const id of selected) {
    if (id === undefined || choices.some((choice) => choice.value === id)) continue;
    choices.push(connections === undefined
      ? { value: id, name: "Saved bot" }
      : { value: id, name: "Removed bot", unavailable: "removed" });
  }
  return choices;
}

function choiceFor(value: string, connection: TelegramConnectionStatus): TelegramBotChoice {
  return {
    value,
    name: connection.displayName,
    ...(connection.enabled ? {} : { unavailable: "disabled" as const }),
    ...(connection.enabled && !connection.verified ? { offline: true } : {}),
  };
}

/**
 * The bot a new conversation starts on: the original route when the profile
 * has one, else the first enabled named bot.
 */
export function defaultTelegramBot(
  connections: readonly TelegramConnectionStatus[] | undefined,
): string {
  if (!connections || connections.length === 0 || connections.some((connection) => connection.legacy)) {
    return ORIGINAL_TELEGRAM_BOT;
  }
  return connections.find((connection) => connection.enabled)?.id ?? ORIGINAL_TELEGRAM_BOT;
}

/** A provider's starting bot: the default Telegram bot, or none elsewhere. */
export function defaultTelegramConnectionFor(
  provider: string,
  connections: readonly TelegramConnectionStatus[] | undefined,
): string | undefined {
  return provider === "telegram" ? telegramConnectionId(defaultTelegramBot(connections)) : undefined;
}

/** The picker shows only when there is a choice to make or a problem to see. */
export function showTelegramBotPicker(choices: readonly TelegramBotChoice[]): boolean {
  return choices.some((choice) => choice.value !== ORIGINAL_TELEGRAM_BOT || choice.unavailable);
}

export function telegramBotOptions(choices: readonly TelegramBotChoice[]): SelectOption<string>[] {
  return choices.map((choice) => ({
    value: choice.value,
    label: telegramBotLabel(choice),
    // Listed so a saved selection still reads, but not offered for new picks.
    ...(choice.unavailable ? { disabled: true } : {}),
  }));
}

export function telegramBotLabel(choice: TelegramBotChoice): string {
  if (choice.unavailable === "removed") return `${choice.name} (unavailable)`;
  if (choice.unavailable === "disabled") return `${choice.name} (disabled)`;
  if (choice.offline) return `${choice.name} (not connected)`;
  return choice.name;
}
