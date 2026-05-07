/**
 * Channel-neutral catalog of the canonical PwrAgent slash commands.
 *
 * Single source of truth for the verb list shared by:
 *   - The controller's `handleCommand` dispatch (verb → handler).
 *   - The user-facing `/help` body, which lists every verb here with
 *     its description.
 *   - Provider adapters that register native slash commands
 *     (Discord's application commands, Mattermost's
 *     `/api/v4/commands`). Today each adapter declares its own
 *     command list; future work can collapse those onto this catalog
 *     so adding a new verb only requires touching one file.
 *
 * Why a catalog instead of inline strings? The previous shape had
 * the verb list hardcoded in two places (the if/else routing and the
 * help body), which silently went stale every time we added or
 * renamed a command. Driving help generation from the catalog means
 * the documentation stays in lockstep with the routing.
 *
 * To add a new verb:
 *   1. Add an entry here with a stable `verb`, a one-line
 *      `description`, and an `aliases` array if you want extra text
 *      synonyms (e.g., `"projects"` → `"resume"`).
 *   2. Wire the handler in `MessagingController.handleCommand` (this
 *      module deliberately does NOT export the dispatch table — the
 *      controller owns its own state and shouldn't be coupled to a
 *      data structure that lives elsewhere).
 *   3. Bump the `MessagingCommandVerb` union below.
 *   4. Each provider adapter that registers native slash commands
 *      should pick up the new verb from its own list (until the
 *      shared-catalog refactor lands).
 */

/**
 * Stable string identifiers for every canonical command verb. Used
 * as the dispatch key in the controller and the trigger name in
 * provider adapters (with optional namespacing — e.g. Mattermost
 * registers them as `pwragent_resume`, `pwragent_status`, etc.).
 *
 * Keep this in sync with `MESSAGING_COMMAND_CATALOG` below.
 */
export type MessagingCommandVerb = "resume" | "status" | "detach" | "help";

export type MessagingCommandSpec = {
  verb: MessagingCommandVerb;
  /**
   * One-line summary shown in the `/help` body. Should fit on a
   * single line and use the imperative form (matches the existing
   * Discord application-command and Mattermost slash-command
   * descriptions).
   */
  description: string;
};

/**
 * Canonical command set, in the order they should appear in the
 * `/help` body. Order is intentional — `resume` first because it's
 * the most common entry point, `help` last because it's the
 * meta-command.
 */
export const MESSAGING_COMMAND_CATALOG: readonly MessagingCommandSpec[] = [
  {
    verb: "resume",
    description: "choose a thread to control from this conversation",
  },
  {
    verb: "status",
    description: "show the current binding and controls",
  },
  {
    verb: "detach",
    description: "detach this conversation from its thread",
  },
  {
    verb: "help",
    description: "show this message",
  },
];

/**
 * Format the `/help` body as a single string, derived from
 * `MESSAGING_COMMAND_CATALOG` so adding a new verb keeps the help
 * surface in sync automatically.
 *
 * The `invocationFooter` is appended verbatim; callers pass a
 * provider-aware string that documents BOTH invocation styles
 * (slash menu and bot mention). The default is provider-neutral
 * (works on every messaging platform that accepts at least one of
 * the two styles).
 *
 * Output format:
 *
 *   • `verb` — description
 *   • `verb` — description
 *
 *   <invocation footer>
 */
export function formatMessagingCommandHelpBody(options?: {
  catalog?: readonly MessagingCommandSpec[];
  invocationFooter?: string;
}): string {
  const catalog = options?.catalog ?? MESSAGING_COMMAND_CATALOG;
  const footer =
    options?.invocationFooter
    ?? "Invoke via the slash menu (`/<cmd>`) or by mentioning the bot (`@<bot> <cmd>`).";
  const lines = catalog.map(
    (spec) => `• \`${spec.verb}\` — ${spec.description}`,
  );
  return [...lines, "", footer].join("\n");
}

/**
 * Resolve a raw command string (as it arrives in
 * `MessagingInboundCommandEvent.command` after the leading slash is
 * stripped) to a known catalog verb, or `undefined` for unknown
 * commands. Case-insensitive. Used by the controller's
 * `handleCommand` to decide whether to dispatch to a verb-specific
 * handler or fall through to the help surface.
 *
 * Kept here (next to the catalog itself) rather than in the
 * controller because future contributors looking at the catalog to
 * understand the verb set should immediately see the matcher
 * alongside.
 */
export function matchMessagingCommandVerb(
  rawCommand: string,
): MessagingCommandVerb | undefined {
  // Trim FIRST (handles `"  /status  "`), then strip the leading
  // slash, then lowercase for case-insensitive lookup. Reversing
  // these steps would let leading whitespace mask the slash and
  // accidentally treat the slash as part of the verb token.
  const normalized = rawCommand.trim().replace(/^\/+/, "").toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  for (const spec of MESSAGING_COMMAND_CATALOG) {
    if (spec.verb === normalized) {
      return spec.verb;
    }
  }
  return undefined;
}
