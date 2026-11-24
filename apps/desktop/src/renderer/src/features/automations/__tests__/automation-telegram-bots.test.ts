import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TelegramConnectionStatus } from "@pwragent/shared/contracts/settings";
import {
  ORIGINAL_TELEGRAM_BOT,
  defaultTelegramBot,
  showTelegramBotPicker,
  telegramBotChoices,
  telegramBotOptions,
  withNamedTelegramBots,
} from "../automation-telegram-bots";

const IDS = [`mc_${"a".repeat(32)}`, `mc_${"b".repeat(32)}`, `mc_${"c".repeat(32)}`];

const status = (id: string, legacy: boolean) =>
  fc.record({
    enabled: fc.boolean(),
    verified: fc.boolean(),
  }).map(({ enabled, verified }): TelegramConnectionStatus => ({
    id,
    displayName: legacy ? "Telegram" : `Bot ${id.slice(3, 4)}`,
    enabled,
    legacy,
    verified: enabled && verified,
  }));

// The shapes Settings can produce: nothing yet, or up to two bots with at
// most one original.
const connections = fc.oneof(
  fc.constant(undefined),
  fc.tuple(fc.boolean(), fc.subarray(IDS.slice(0, 2), { maxLength: 2 })).chain(([legacy, named]) =>
    fc.tuple(
      legacy ? status(IDS[2], true).map((row) => [row]) : fc.constant([]),
      fc.tuple(...named.map((id) => status(id, false))),
    ).map(([original, rows]) => [...original, ...rows].slice(0, 2))),
);
const selected = fc.array(fc.constantFrom(undefined, ...IDS), { maxLength: 4 });

describe("telegramBotChoices", () => {
  it("keeps every saved bot as its own choice, unavailable unless Settings runs it", () => {
    fc.assert(fc.property(connections, selected, (rows, saved) => {
      const choices = telegramBotChoices(rows, saved);
      for (const id of saved) {
        const value = id ?? ORIGINAL_TELEGRAM_BOT;
        const choice = choices.find((entry) => entry.value === value);
        // Oracle: Settings' own row for that exact bot.
        const row = id === undefined
          ? rows?.find((entry) => entry.legacy)
          : rows?.find((entry) => entry.id === id && !entry.legacy);
        expect(choice).toBeDefined();
        if (rows === undefined) continue;
        if (id === undefined && rows.length === 0) {
          // The unmigrated profile's one bot is the original route.
          expect(choice?.unavailable).toBeUndefined();
        } else if (!row) {
          expect(choice?.unavailable).toBe("removed");
        } else {
          expect(choice?.unavailable).toBe(row.enabled ? undefined : "disabled");
        }
      }
      // A choice value is unique, so one selection never stands for two bots.
      expect(new Set(choices.map((choice) => choice.value)).size).toBe(choices.length);
    }));
  });

  it("offers only available bots for a new pick", () => {
    fc.assert(fc.property(connections, selected, (rows, saved) => {
      const choices = telegramBotChoices(rows, saved);
      for (const option of telegramBotOptions(choices)) {
        const choice = choices.find((entry) => entry.value === option.value);
        expect(Boolean(option.disabled)).toBe(Boolean(choice?.unavailable));
      }
    }));
  });

  it("starts new conversations on an available bot", () => {
    fc.assert(fc.property(connections, (rows) => {
      const bot = defaultTelegramBot(rows);
      // Oracle: a running original bot wins; otherwise any enabled named bot
      // beats a stopped original route.
      const originalRuns = rows?.some((row) => row.legacy && row.enabled);
      const namedRuns = rows?.some((row) => !row.legacy && row.enabled);
      if (bot === ORIGINAL_TELEGRAM_BOT) {
        expect(!rows?.length || originalRuns || !namedRuns).toBe(true);
      } else {
        expect(originalRuns).toBe(false);
        expect(rows?.find((row) => row.id === bot)).toMatchObject({ enabled: true, legacy: false });
      }
    }));
  });

  it("offers Telegram whenever any of its bots runs", () => {
    const providers = fc.subarray(["telegram", "slack", "discord"] as const);
    fc.assert(fc.property(providers, connections, (settings, rows) => {
      const result = withNamedTelegramBots(settings, rows);
      // Oracle: Settings' list, plus Telegram when an enabled named bot runs.
      const expected = new Set<string>(settings);
      if (rows?.some((row) => !row.legacy && row.enabled)) expected.add("telegram");
      expect(new Set(result)).toEqual(expected);
      expect(result).toHaveLength(expected.size);
      expect(result.filter((provider) => provider !== "telegram")).toEqual(
        settings.filter((provider) => provider !== "telegram"),
      );
    }));
  });

  it("hides the picker for a profile with only the original bot", () => {
    expect(showTelegramBotPicker(telegramBotChoices(undefined, [undefined]))).toBe(false);
    expect(showTelegramBotPicker(telegramBotChoices([], [undefined]))).toBe(false);
    expect(showTelegramBotPicker(telegramBotChoices([], [IDS[0]]))).toBe(true);
  });
});
