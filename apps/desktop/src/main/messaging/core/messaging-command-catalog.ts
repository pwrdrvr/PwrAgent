import {
  capabilityProfilePageSize,
  type MessagingCapabilityProfile,
  type MessagingSurfaceAction,
} from "@pwragent/messaging-interface";

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

// -----------------------------------------------------------------
// Help-surface action layout
// -----------------------------------------------------------------

/**
 * Worst-case nav-button budget on a paginated help surface:
 *   - Previous (only when page > 0)
 *   - Next (only when more pages remain)
 *   - Cancel (always rendered)
 *
 * Used by `helpPageSize` to reserve action slots from the capability
 * profile so the navigation buttons always fit. We always reserve
 * for the worst case (3) even on the first/last page where Prev or
 * Next is hidden — keeps page-size constant across pages so users
 * don't see the layout grow and shrink as they navigate.
 */
export const HELP_NAV_ACTION_COUNT = 3;

/**
 * Soft cap on how many command buttons we'll show per page even
 * when the capability profile would allow more. Help is read,
 * not skimmed — eight buttons on one screen is plenty.
 */
const HELP_PAGE_SIZE = 8;

export type MessagingCommandHelpPage = {
  pageIndex: number;
  totalPages: number;
  /**
   * Capability-aware page size after subtracting nav reservation.
   * Zero means the profile's action budget is fully consumed by
   * navigation; the caller should fall back to text-only rendering
   * (the help body already lists every verb in prose).
   */
  pageSize: number;
  /**
   * Subset of `MESSAGING_COMMAND_CATALOG` for this page, in catalog
   * order. Empty when `pageSize === 0`.
   */
  commands: readonly MessagingCommandSpec[];
};

/**
 * Compute how many command buttons to render per page given a
 * capability profile. Defers to `capabilityProfilePageSize` so the
 * nav-button reservation matches the resume browser's pattern.
 *
 * Returns 0 when the profile has fewer than `HELP_NAV_ACTION_COUNT`
 * action slots — the caller falls back to text-only rendering.
 */
export function helpPageSize(
  profile?: MessagingCapabilityProfile,
): number {
  if (!profile) {
    return HELP_PAGE_SIZE;
  }
  return capabilityProfilePageSize(
    profile,
    HELP_NAV_ACTION_COUNT,
    HELP_PAGE_SIZE,
  );
}

/**
 * Page the catalog for rendering as command buttons. Clamps
 * `pageIndex` to a valid range and reports the resolved page so
 * callers can render an accurate "Page X/Y" indicator. When the
 * total catalog fits in one page (`totalPages === 1`), nav
 * buttons should be omitted by the caller — see
 * `buildHelpActions` for the canonical pattern.
 */
export function paginateHelpCatalog(params: {
  catalog?: readonly MessagingCommandSpec[];
  profile?: MessagingCapabilityProfile;
  pageIndex?: number;
}): MessagingCommandHelpPage {
  const catalog = params.catalog ?? MESSAGING_COMMAND_CATALOG;
  const pageSize = helpPageSize(params.profile);
  if (pageSize <= 0) {
    return { pageIndex: 0, totalPages: 0, pageSize: 0, commands: [] };
  }
  const totalPages = Math.max(1, Math.ceil(catalog.length / pageSize));
  const clamped = Math.max(0, Math.min(totalPages - 1, params.pageIndex ?? 0));
  const start = clamped * pageSize;
  const commands = catalog.slice(start, start + pageSize);
  return { pageIndex: clamped, totalPages, pageSize, commands };
}

/**
 * Build the action array for the help surface — one command button
 * per verb on the current page, plus navigation buttons (Prev /
 * Next / Cancel) when the catalog overflows a single page. The
 * navigation row is omitted entirely when everything fits in one
 * page, so the help surface renders as a tight verb-button row in
 * the steady state of today's small catalog.
 *
 * Action id conventions:
 *   - `command:<verb>` — invoke the verb. Routes through
 *     `readCommandAction` in the controller and dispatches to
 *     `handleCommand`. The same actionId pattern is already in use
 *     for the existing single Resume button on the help surface, so
 *     this just expands the set.
 *   - `help:page:next` / `help:page:prev` — navigation. The next
 *     page index travels in `action.value.pageIndex` so the
 *     callback handler can re-render without persistent session
 *     state (help is stateless — the catalog is deterministic from
 *     pageIndex alone).
 *   - `help:cancel` — dismiss the surface. The controller's
 *     callback handler updates the surface to remove the action
 *     row and replaces the body with a brief "help dismissed"
 *     line.
 */
export function buildHelpActions(params: {
  page: MessagingCommandHelpPage;
}): MessagingSurfaceAction[] {
  const { page } = params;
  if (page.pageSize <= 0 || page.commands.length === 0) {
    return [];
  }
  const actions: MessagingSurfaceAction[] = [];
  for (const spec of page.commands) {
    actions.push({
      id: `command:${spec.verb}`,
      label: capitalize(spec.verb),
      // `resume` stays primary so the button hierarchy matches the
      // existing single-button help surface (where Resume is also
      // the primary). Other verbs use the default neutral style.
      style: spec.verb === "resume" ? "primary" : undefined,
      fallbackText: `/${spec.verb}`,
    });
  }
  // Nav row only when there's more than one page. Single-page
  // rendering keeps the help surface compact.
  if (page.totalPages > 1) {
    if (page.pageIndex > 0) {
      actions.push({
        id: "help:page:prev",
        label: "Previous",
        style: "navigation",
        fallbackText: "back",
        value: { pageIndex: page.pageIndex - 1 },
      });
    }
    if (page.pageIndex < page.totalPages - 1) {
      actions.push({
        id: "help:page:next",
        label: "Next",
        style: "navigation",
        fallbackText: "next",
        value: { pageIndex: page.pageIndex + 1 },
      });
    }
    actions.push({
      id: "help:cancel",
      label: "Cancel",
      style: "secondary",
      fallbackText: "cancel",
    });
  }
  return actions;
}

function capitalize(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
