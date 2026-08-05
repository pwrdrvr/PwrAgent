export type MessagingCommandCatalogEntry = {
  description: string;
  /** Whether `/help` can invoke the command without collecting arguments first. */
  helpAction: boolean;
  verb: string;
};

/**
 * Channel-neutral PwrAgent command surface.
 *
 * Desktop orchestration owns dispatch. Provider adapters consume this catalog
 * only to expose the same verbs through their native command surfaces.
 */
export const MESSAGING_COMMAND_CATALOG = [
  {
    verb: "resume",
    description: "choose a thread to control from this conversation",
    helpAction: true,
  },
  {
    verb: "agent",
    description: "choose an Agent thread, or manage the default with /agent default",
    helpAction: true,
  },
  {
    verb: "new",
    description: "start a new thread from a project",
    helpAction: true,
  },
  {
    verb: "status",
    description: "show the current binding and controls",
    helpAction: true,
  },
  {
    verb: "detach",
    description: "detach this conversation from its thread",
    helpAction: true,
  },
  {
    verb: "monitor",
    description: "monitor recent PwrAgent threads once per minute",
    helpAction: true,
  },
  {
    verb: "schedule",
    description: "schedule a message for the bound thread",
    helpAction: false,
  },
  {
    verb: "scheduled",
    description: "list or manage scheduled messages",
    helpAction: true,
  },
  {
    verb: "help",
    description: "show this message",
    helpAction: true,
  },
] as const satisfies readonly MessagingCommandCatalogEntry[];

export type MessagingCommandVerb =
  (typeof MESSAGING_COMMAND_CATALOG)[number]["verb"];
export type MessagingCommandSpec = {
  description: string;
  helpAction: boolean;
  verb: MessagingCommandVerb;
};

export const MESSAGING_HELP_ACTION_COMMANDS: readonly MessagingCommandSpec[] =
  MESSAGING_COMMAND_CATALOG.filter((command) => command.helpAction);

export function matchMessagingCommandVerb(
  rawCommand: string,
): MessagingCommandVerb | undefined {
  const normalized = rawCommand.trim().replace(/^\/+/, "").toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  return MESSAGING_COMMAND_CATALOG.find(
    (command) => command.verb === normalized,
  )?.verb;
}
