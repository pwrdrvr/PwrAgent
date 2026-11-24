import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationMessagingConversationSnapshot } from "@pwragent/shared/contracts/automations";
import type {
  ListTelegramConnectionConversationsResponse,
  MessagingChannelKind,
} from "@pwragent/shared/contracts/messaging";
import type { TelegramConnectionStatus } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  defaultTelegramBot,
  showTelegramBotPicker,
  telegramBotChoices,
  telegramBotLabel,
  telegramBotOptions,
  telegramBotValue,
  telegramConnectionId,
  type TelegramBotChoice,
} from "./automation-telegram-bots";

/**
 * The Automations editor's Telegram bots: the profile's saved bots, each
 * bot's own conversation list, and the choices both Bot pickers offer.
 */
export function useAutomationTelegramBots(
  desktopApi: DesktopApi | undefined,
  fields: {
    inboundProvider: MessagingChannelKind;
    destProvider: MessagingChannelKind;
    /** The destination fields are in use, so its bot's list is wanted. */
    destinationShown: boolean;
    extraSources: readonly AutomationMessagingConversationSnapshot[];
  },
  savedSource: AutomationMessagingConversationSnapshot | undefined,
  savedTarget: AutomationMessagingConversationSnapshot | undefined,
) {
  // The exact bot each side's conversation goes through. Undefined is the
  // original route, which saves without a connection ID. Without a saved
  // destination it starts where its provider does: on the saved trigger's.
  const [inboundConnectionId, setInboundConnectionId] = useState(savedSource?.connectionId);
  const [destConnectionId, setDestConnectionId] = useState(
    savedTarget ? savedTarget.connectionId : savedSource?.connectionId,
  );
  // Undefined until Settings answers, so a saved named bot is not called
  // removed before anyone has looked.
  const [telegramConnections, setTelegramConnections] = useState<TelegramConnectionStatus[]>();
  useEffect(() => {
    const list = desktopApi?.listTelegramConnections;
    if (!list) {
      setTelegramConnections([]);
      return;
    }
    let cancelled = false;
    void list()
      .then((connections) => {
        if (!cancelled) setTelegramConnections(connections);
      })
      .catch(() => {
        // Without an answer every saved bot stays as saved, unjudged.
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  // Each bot's own audience, keyed by its picker value. A named bot lists
  // only what it was authorized for; it never borrows the original bot's list.
  const [telegramCatalogs, setTelegramCatalogs] = useState<
    Record<string, ListTelegramConnectionConversationsResponse>
  >({});
  const requestedRef = useRef(new Set<string>());
  const loadTelegramCatalog = useCallback(
    async (bot: string): Promise<void> => {
      const list = desktopApi?.listTelegramConnectionConversations;
      if (!list) return;
      requestedRef.current.add(bot);
      try {
        const connectionId = telegramConnectionId(bot);
        const catalog = await list(connectionId === undefined ? {} : { connectionId });
        setTelegramCatalogs((current) => ({ ...current, [bot]: catalog }));
      } catch {
        // The fields fall back to typing an ID, as with any unlisted catalog.
      }
    },
    [desktopApi],
  );

  const inboundTelegram = fields.inboundProvider === "telegram";
  const destTelegram = fields.destProvider === "telegram";
  // Every bot the two pickers may show: the saved bots, plus any bot a saved
  // source or destination still names after it was removed.
  const telegramChoices = telegramBotChoices(telegramConnections, [
    ...(inboundTelegram ? [inboundConnectionId] : []),
    ...fields.extraSources
      .filter((source) => source.channel === "telegram")
      .map((source) => source.connectionId),
    ...(destTelegram ? [destConnectionId] : []),
  ]);
  const telegramBotPickerShown = showTelegramBotPicker(telegramChoices);
  const choiceFor = (connectionId: string | undefined): TelegramBotChoice | undefined =>
    telegramChoices.find((choice) => choice.value === telegramBotValue(connectionId));
  // The same group can be watched through two bots, so a listed source names
  // its bot whenever the profile has more than one.
  const sourceBotName = (source: AutomationMessagingConversationSnapshot): string | undefined => {
    if (!telegramBotPickerShown || source.channel !== "telegram") return undefined;
    const choice = choiceFor(source.connectionId);
    return choice ? telegramBotLabel(choice) : undefined;
  };

  // A new automation starts on the profile's original bot. When the profile
  // has only named bots, it starts on the first enabled one instead of a
  // route no bot answers. A saved source or destination is never moved.
  const defaultAppliedRef = useRef(false);
  const newSource = savedSource === undefined;
  const newTarget = savedTarget === undefined && newSource;
  useEffect(() => {
    if (defaultAppliedRef.current || telegramConnections === undefined) return;
    defaultAppliedRef.current = true;
    const bot = telegramConnectionId(defaultTelegramBot(telegramConnections));
    if (bot === undefined) return;
    if (newSource && inboundTelegram) setInboundConnectionId(bot);
    if (newTarget && destTelegram) setDestConnectionId(bot);
  }, [destTelegram, inboundTelegram, newSource, newTarget, telegramConnections]);

  // A string, so the effect reruns only when the set of bots changes.
  const catalogsWanted = JSON.stringify([
    ...(inboundTelegram ? [telegramBotValue(inboundConnectionId)] : []),
    ...(destTelegram && fields.destinationShown ? [telegramBotValue(destConnectionId)] : []),
  ]);
  useEffect(() => {
    for (const bot of JSON.parse(catalogsWanted) as string[]) {
      if (!requestedRef.current.has(bot)) void loadTelegramCatalog(bot);
    }
  }, [catalogsWanted, loadTelegramCatalog]);

  return {
    inboundConnectionId,
    setInboundConnectionId,
    destConnectionId,
    setDestConnectionId,
    telegramConnections,
    telegramCatalogs,
    loadTelegramCatalog,
    telegramBotOptions: telegramBotOptions(telegramChoices),
    // Each side's bot, only while its Bot picker shows: Telegram, with a
    // choice to make or an unavailable bot to see.
    inboundBotChoice: inboundTelegram && telegramBotPickerShown ? choiceFor(inboundConnectionId) : undefined,
    destBotChoice: destTelegram && telegramBotPickerShown ? choiceFor(destConnectionId) : undefined,
    sourceBotName,
  };
}
