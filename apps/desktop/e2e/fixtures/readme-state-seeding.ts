import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Test-only sqlite seed helpers for the README screenshot spec.
//
// These let the screenshot tests inject `bindings`,
// `messaging_activity_log`, and `messaging_pairing_tokens` rows after
// the desktop app has migrated its schema. We do this directly rather
// than going through `SqliteMessagingStore.upsertBinding` etc. because
// the production helpers carry sanitization rules and an allowlist of
// production `MessagingChannelKind` values; for purely visual capture
// we only need the columns the renderer reads, with payload JSON
// shaped well enough to round-trip through the renderer's
// `JSON.parse(payload)` lookups in
// `MessagingActivityScreen.tsx` / sidebar binding chip code.
//
// IMPORTANT: only used from the screenshot inspect spec. Do not import
// from production code. The `MessagingChannelRef` / `LinkedDirectorySummary`
// shapes are pulled from runtime types so the seeded rows stay in sync
// with future renderer expectations — if those types change in a way
// that affects rendering, this module breaks loudly at the type level.

export function stateDbPathForHomeRoot(homeRoot: string): string {
  return path.join(homeRoot, ".pwragent/profiles/default/state/state.db");
}

export function configTomlPathForHomeRoot(homeRoot: string): string {
  return path.join(homeRoot, ".pwragent/profiles/default/config.toml");
}

/**
 * Seed a `config.toml` that has the messaging master switch and the
 * Telegram adapter both enabled. Used as a `preLaunchHook` so the
 * Settings → Messaging surface boots into an "enabled" state and the
 * Pairing field's Generate button is clickable. No real bot token is
 * required — the pairing token generator is a local HMAC+sqlite write
 * that does not touch the network (see
 * `MessagingRuntime.generatePairingToken`).
 */
export function seedTelegramEnabledConfig(homeRoot: string): void {
  const configPath = configTomlPathForHomeRoot(homeRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      "[messaging]",
      "enabled = true",
      "",
      "[messaging.telegram]",
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
}

type SeedTelegramBindingParams = {
  stateDbPath: string;
  threadId: string;
  conversationTitle: string;
  /** Telegram peer/chat numeric id, used for both channel routing and the actor id. */
  conversationId?: string;
  bindingId?: string;
  now?: number;
};

/**
 * Insert a "telegram DM" binding row so the active thread renders a
 * binding chip. Returns the bindingId so callers can chain it into
 * other seed calls (activity log entries reference binding_id).
 */
export function seedTelegramBinding(params: SeedTelegramBindingParams): string {
  const now = params.now ?? 1715431200000;
  const bindingId = params.bindingId ?? "binding-readme-bound-thread";
  const conversationId = params.conversationId ?? "1234567890";
  const conversation = {
    id: conversationId,
    kind: "dm" as const,
    title: params.conversationTitle,
  };
  const channel = {
    channel: "telegram" as const,
    conversation,
  };
  // `buildChannelId` in messaging-store-sqlite.ts: `<kind>:<parentId>:<id>`.
  const channelIdKey = ["dm", "", conversationId].join(":");
  const payload = {
    id: bindingId,
    channel,
    backend: "codex",
    threadId: params.threadId,
    authorizedActorIds: [conversationId],
    createdAt: now,
    updatedAt: now,
  };

  const db = new Database(params.stateDbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bindingId,
      channel.channel,
      channelIdKey,
      params.threadId,
      "active",
      now,
      now,
      null,
      JSON.stringify(payload),
    );
  } finally {
    db.close();
  }
  return bindingId;
}

export type SeedActivityEntry = {
  platform: "telegram" | "discord" | "slack" | "mattermost";
  kind:
    | "inbound-routed"
    | "inbound-rejected"
    | "inbound-ignored"
    | "pairing"
    | "outbound"
    | "binding"
    | "diagnostic";
  threadId?: string;
  bindingId?: string;
  conversationId?: string;
  conversationTitle?: string;
  actorId?: string;
  actorDisplayName?: string;
  summary: string;
  /** Most-recent-first ordering — pass an absolute timestamp per row. */
  createdAt: number;
  /**
   * Free-form payload bag. The renderer reads:
   *   - conversationKind
   *   - conversationParentId (becomes "Supergroup ID" / "Guild ID" / etc.)
   *   - conversationBucketId
   * Anything else is preserved but not rendered.
   */
  payload?: Record<string, unknown>;
};

/**
 * Bulk-insert messaging activity log rows. Order is preserved by
 * created_at descending in the renderer's pull, so timestamps that
 * decrease across the array show up newest-first in the panel.
 */
export function seedActivityEntries(
  stateDbPath: string,
  entries: SeedActivityEntry[],
): void {
  const db = new Database(stateDbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO messaging_activity_log(
         platform, kind, thread_id, binding_id, conversation_id,
         conversation_title, actor_id, actor_display_name,
         summary, created_at, payload
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      insert.run(
        entry.platform,
        entry.kind,
        entry.threadId ?? null,
        entry.bindingId ?? null,
        entry.conversationId ?? null,
        entry.conversationTitle ?? null,
        entry.actorId ?? null,
        entry.actorDisplayName ?? null,
        entry.summary,
        entry.createdAt,
        JSON.stringify(entry.payload ?? {}),
      );
    }
  } finally {
    db.close();
  }
}

export type SeedPairingEntry = {
  entryId: string;
  platform: "telegram" | "discord" | "slack" | "mattermost";
  instanceId: string;
  scope: "user_dm" | "user_group" | "group_chat";
  status:
    | "pending"
    | "observed"
    | "approved"
    | "rejected"
    | "expired"
    | "consumed";
  generatedAt: number;
  expiresAt: number;
  observedAt?: number;
  /**
   * Caller-controlled token text. Real generation derives this from a
   * secret HMAC — for screenshot purposes any plausible-looking opaque
   * string is fine. The renderer renders this as the "pair <token>"
   * line under the Pairing field's Generate button.
   */
  tokenHmac?: string;
  payload?: Record<string, unknown>;
};

/**
 * Insert a pairing token row so the Pairing field can render different
 * states (generated → observed → approved) without needing a real
 * messaging adapter to be running.
 */
export function seedPairingEntry(
  stateDbPath: string,
  entry: SeedPairingEntry,
): void {
  const db = new Database(stateDbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO messaging_pairing_tokens(
         entry_id, token_hmac, platform, instance_id, scope, status,
         generated_at, expires_at, observed_at, payload
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.entryId,
      entry.tokenHmac ?? `hmac-${entry.entryId}`,
      entry.platform,
      entry.instanceId,
      entry.scope,
      entry.status,
      entry.generatedAt,
      entry.expiresAt,
      entry.observedAt ?? null,
      JSON.stringify(entry.payload ?? {}),
    );
  } finally {
    db.close();
  }
}

/**
 * Wipe all pairing tokens. Useful between frames in a multi-state
 * capture so a "rejected" frame doesn't carry over a stale "approved"
 * record.
 */
export function clearPairingEntries(stateDbPath: string): void {
  const db = new Database(stateDbPath);
  try {
    db.prepare("DELETE FROM messaging_pairing_tokens").run();
  } finally {
    db.close();
  }
}

/**
 * Find the most recently generated pairing entry for a platform. Used
 * by the pairing GIF capture to look up the entry id of the row the
 * renderer just created via the Generate button, so that row can be
 * mutated into the "observed" state for the next frame.
 *
 * Returns undefined when no entry exists.
 */
export function findLatestPairingEntryId(
  stateDbPath: string,
  platform: "telegram" | "discord" | "slack" | "mattermost",
): string | undefined {
  const db = new Database(stateDbPath);
  try {
    const row = db
      .prepare(
        `SELECT entry_id FROM messaging_pairing_tokens
         WHERE platform = ?
         ORDER BY generated_at DESC
         LIMIT 1`,
      )
      .get(platform) as { entry_id: string } | undefined;
    return row?.entry_id;
  } finally {
    db.close();
  }
}

export type ObservedActor = {
  id: string;
  displayName?: string;
  username?: string;
  phoneNumber?: string;
};

export type ObservedChat = {
  id: string;
  kind: "dm" | "channel" | "thread" | "topic";
  title?: string;
  parentId?: string;
  parentTitle?: string;
  bucketId?: string;
};

/**
 * Mark an existing pairing entry as observed (the state that fires
 * after a user sends the pair code to the bot from chat). Mirrors
 * `MessagingPairingStore.markObserved` — sets `status = 'observed'`,
 * stamps `observed_at`, and writes `observedActor` / `observedChat`
 * into the payload JSON. Throws when the entry id isn't found so the
 * test fails fast.
 */
export function markPairingObserved(
  stateDbPath: string,
  entryId: string,
  params: {
    observedAt?: number;
    observedActor: ObservedActor;
    observedChat: ObservedChat;
  },
): void {
  const observedAt = params.observedAt ?? Date.now();
  const db = new Database(stateDbPath);
  try {
    const row = db
      .prepare(
        "SELECT payload FROM messaging_pairing_tokens WHERE entry_id = ?",
      )
      .get(entryId) as { payload: string } | undefined;
    if (!row) {
      throw new Error(
        `markPairingObserved: no messaging_pairing_tokens row with entry_id=${entryId}`,
      );
    }
    const existing = (() => {
      try {
        return JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const payload = {
      ...existing,
      observedActor: params.observedActor,
      observedChat: params.observedChat,
    };
    db.prepare(
      `UPDATE messaging_pairing_tokens
       SET status = 'observed', observed_at = ?, payload = ?
       WHERE entry_id = ?`,
    ).run(observedAt, JSON.stringify(payload), entryId);
  } finally {
    db.close();
  }
}
