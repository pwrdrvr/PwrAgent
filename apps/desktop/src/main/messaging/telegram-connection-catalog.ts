import type {
  ListTelegramConnectionConversationsResponse,
  TelegramConnectionConversation,
} from "@pwragent/shared/contracts/messaging";
import type {
  DesktopAuthorizedContact,
  DesktopTelegramConnection,
  DesktopTelegramPairingGrants,
} from "@pwragent/shared/contracts/settings";

/**
 * The conversations one Telegram bot may watch or reply to, for the
 * Automations editor's pickers.
 *
 * An absent `connectionId` is the original bot's route: its settings
 * allowlists plus its pairing grants. A named connection lists its own
 * configured IDs plus the grants in its own store, and nothing else. It never
 * falls back to the original bot's audience: the same group or person can be
 * authorized on one bot and not the other, and an automation saved against
 * one bot is never delivered through the other.
 */
export function resolveTelegramConnectionConversations(params: {
  connectionId?: string;
  /** The configured connection list; `undefined` before the first named bot. */
  connections: readonly DesktopTelegramConnection[] | undefined;
  original: {
    supergroups: readonly DesktopAuthorizedContact[];
    users: readonly DesktopAuthorizedContact[];
    grants?: DesktopTelegramPairingGrants;
  };
  /** Grants in a named connection's store; `undefined` unless it runs here. */
  readNamedGrants: (connection: DesktopTelegramConnection) => DesktopTelegramPairingGrants | undefined;
}): ListTelegramConnectionConversationsResponse {
  if (params.connectionId === undefined) {
    const legacy = params.connections?.find((connection) => connection.legacy);
    if (params.connections !== undefined && !legacy) return unavailable("missing");
    if (legacy && !legacy.enabled) return unavailable("disabled");
    return {
      status: "available",
      supergroups: merge(params.original.supergroups, params.original.grants?.supergroups),
      users: merge(params.original.users, params.original.grants?.users),
    };
  }
  const connection = params.connections?.find((row) => row.id === params.connectionId && !row.legacy);
  if (!connection) return unavailable("missing");
  if (!connection.enabled) return unavailable("disabled");
  const grants = params.readNamedGrants(connection);
  if (!grants || grants.accountId !== connection.botAccountId) return unavailable("offline");
  return {
    status: "available",
    supergroups: merge(connection.authorizedSupergroupIds.map((id) => ({ id })), grants.supergroups),
    users: merge(connection.authorizedUserIds.map((id) => ({ id })), grants.users),
  };
}

function unavailable(
  status: Exclude<ListTelegramConnectionConversationsResponse["status"], "available">,
): ListTelegramConnectionConversationsResponse {
  return { status, supergroups: [], users: [] };
}

/** Configured IDs first, in order; a grant names an ID the config left unnamed. */
function merge(
  configured: readonly { id: string; displayName?: string }[],
  granted: readonly { id: string; displayName?: string }[] = [],
): TelegramConnectionConversation[] {
  const byId = new Map<string, TelegramConnectionConversation>();
  for (const entry of [...configured, ...granted]) {
    const current = byId.get(entry.id);
    const displayName = current?.displayName || entry.displayName || undefined;
    byId.set(entry.id, { id: entry.id, ...(displayName ? { displayName } : {}) });
  }
  return [...byId.values()];
}
