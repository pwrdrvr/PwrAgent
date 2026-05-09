import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  MessagingChannelKind,
  MessagingPairingEntry,
  MessagingPairingObservedActor,
  MessagingPairingObservedChat,
  MessagingPairingScope,
  MessagingPairingStatus,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";

const PAIRING_SECRET_META_KEY = "messaging_pairing_secret_v1";

type PairingRow = {
  entry_id: string;
  token_hmac: string;
  platform: string;
  instance_id: string;
  scope: string;
  status: string;
  generated_at: number;
  expires_at: number;
  observed_at: number | null;
  payload: string;
};

type PairingPayload = {
  observedActor?: MessagingPairingObservedActor;
  observedChat?: MessagingPairingObservedChat;
  failureReason?: string;
};

export class MessagingPairingStore {
  constructor(private readonly stateDb: StateDb) {}

  create(params: {
    token: string;
    platform: MessagingChannelKind;
    instanceId: string;
    scope: MessagingPairingScope;
    generatedAt: number;
    expiresAt: number;
  }): MessagingPairingEntry {
    const entry: MessagingPairingEntry = {
      id: `pairing:${randomUUID()}`,
      platform: params.platform,
      instanceId: params.instanceId,
      scope: params.scope,
      status: "pending",
      generatedAt: params.generatedAt,
      expiresAt: params.expiresAt,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO messaging_pairing_tokens(
           entry_id, token_hmac, platform, instance_id, scope, status,
           generated_at, expires_at, observed_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        this.hmacToken({
          token: params.token,
          platform: params.platform,
          instanceId: params.instanceId,
          scope: params.scope,
          generatedAt: params.generatedAt,
        }),
        params.platform,
        params.instanceId,
        params.scope,
        entry.status,
        params.generatedAt,
        params.expiresAt,
        null,
        JSON.stringify({}),
      );
    return entry;
  }

  findMatchingPending(params: {
    token: string;
    platform: MessagingChannelKind;
    instanceId: string;
    now: number;
  }): MessagingPairingEntry | undefined {
    this.expireBefore(params.now);
    const rows = this.stateDb.raw
      .prepare(
        `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                generated_at, expires_at, observed_at, payload
         FROM messaging_pairing_tokens
         WHERE platform = ?
           AND instance_id = ?
           AND status = 'pending'
           AND expires_at > ?
         ORDER BY generated_at DESC`,
      )
      .all(params.platform, params.instanceId, params.now) as PairingRow[];

    for (const row of rows) {
      const candidate = this.hmacToken({
        token: params.token,
        platform: row.platform as MessagingChannelKind,
        instanceId: row.instance_id,
        scope: row.scope as MessagingPairingScope,
        generatedAt: row.generated_at,
      });
      if (safeEqualHex(candidate, row.token_hmac)) {
        return rowToEntry(row);
      }
    }
    return undefined;
  }

  get(entryId: string, options?: { now?: number }): MessagingPairingEntry | undefined {
    if (options?.now !== undefined) {
      this.expireBefore(options.now);
    }
    const row = this.stateDb.raw
      .prepare(
        `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                generated_at, expires_at, observed_at, payload
         FROM messaging_pairing_tokens
         WHERE entry_id = ?`,
      )
      .get(entryId) as PairingRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  list(params: {
    includeResolved?: boolean;
    platform?: MessagingChannelKind;
    now: number;
  }): MessagingPairingEntry[] {
    this.expireBefore(params.now);
    const rows = params.platform
      ? params.includeResolved
        ? (this.stateDb.raw
            .prepare(
              `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                      generated_at, expires_at, observed_at, payload
               FROM messaging_pairing_tokens
               WHERE platform = ?
               ORDER BY generated_at DESC`,
            )
            .all(params.platform) as PairingRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                      generated_at, expires_at, observed_at, payload
               FROM messaging_pairing_tokens
               WHERE platform = ?
                 AND status IN ('pending', 'observed')
               ORDER BY generated_at DESC`,
            )
            .all(params.platform) as PairingRow[])
      : params.includeResolved
        ? (this.stateDb.raw
            .prepare(
              `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                      generated_at, expires_at, observed_at, payload
               FROM messaging_pairing_tokens
               ORDER BY generated_at DESC`,
            )
            .all() as PairingRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT entry_id, token_hmac, platform, instance_id, scope, status,
                      generated_at, expires_at, observed_at, payload
               FROM messaging_pairing_tokens
               WHERE status IN ('pending', 'observed')
               ORDER BY generated_at DESC`,
            )
            .all() as PairingRow[]);
    return rows.map(rowToEntry);
  }

  countOutstanding(params: {
    platform: MessagingChannelKind;
    instanceId: string;
    now: number;
  }): number {
    this.expireBefore(params.now);
    const row = this.stateDb.raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messaging_pairing_tokens
         WHERE platform = ?
           AND instance_id = ?
           AND status IN ('pending', 'observed')
           AND expires_at > ?`,
      )
      .get(params.platform, params.instanceId, params.now) as { count: number };
    return row.count;
  }

  markObserved(params: {
    entryId: string;
    observedAt: number;
    actor: MessagingPairingObservedActor;
    chat: MessagingPairingObservedChat;
  }): MessagingPairingEntry | undefined {
    const current = this.get(params.entryId);
    if (!current || current.status !== "pending") return current;
    const payload: PairingPayload = {
      observedActor: params.actor,
      observedChat: params.chat,
    };
    this.stateDb.raw
      .prepare(
        `UPDATE messaging_pairing_tokens
         SET status = 'observed', observed_at = ?, payload = ?
         WHERE entry_id = ? AND status = 'pending'`,
      )
      .run(params.observedAt, JSON.stringify(payload), params.entryId);
    return this.get(params.entryId);
  }

  markStatus(params: {
    entryId: string;
    status: Extract<MessagingPairingStatus, "approved" | "rejected" | "consumed">;
    failureReason?: string;
  }): MessagingPairingEntry | undefined {
    const current = this.get(params.entryId);
    if (!current) return undefined;
    const payload: PairingPayload = {
      observedActor: current.observedActor,
      observedChat: current.observedChat,
      ...(params.failureReason ? { failureReason: params.failureReason } : {}),
    };
    this.stateDb.raw
      .prepare(
        `UPDATE messaging_pairing_tokens
         SET status = ?, payload = ?
         WHERE entry_id = ?`,
      )
      .run(params.status, JSON.stringify(payload), params.entryId);
    return this.get(params.entryId);
  }

  expireBefore(now: number): void {
    this.stateDb.raw
      .prepare(
        "UPDATE messaging_pairing_tokens SET status = 'expired' WHERE status IN ('pending', 'observed') AND expires_at <= ?",
      )
      .run(now);
  }

  private hmacToken(params: {
    token: string;
    platform: MessagingChannelKind;
    instanceId: string;
    scope: MessagingPairingScope;
    generatedAt: number;
  }): string {
    return createHmac("sha256", this.secret())
      .update(params.token)
      .update("\0")
      .update(params.platform)
      .update("\0")
      .update(params.instanceId)
      .update("\0")
      .update(params.scope)
      .update("\0")
      .update(String(params.generatedAt))
      .digest("hex");
  }

  private secret(): Buffer {
    const existing = this.stateDb.getMeta(PAIRING_SECRET_META_KEY);
    if (existing) return Buffer.from(existing, "base64");
    const generated = randomBytes(32);
    this.stateDb.setMeta(PAIRING_SECRET_META_KEY, generated.toString("base64"));
    return generated;
  }
}

function rowToEntry(row: PairingRow): MessagingPairingEntry {
  const payload = parsePayload(row.payload);
  return {
    id: row.entry_id,
    platform: row.platform as MessagingChannelKind,
    instanceId: row.instance_id,
    scope: row.scope as MessagingPairingScope,
    status: row.status as MessagingPairingStatus,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    ...(row.observed_at !== null ? { observedAt: row.observed_at } : {}),
    ...(payload.observedActor ? { observedActor: payload.observedActor } : {}),
    ...(payload.observedChat ? { observedChat: payload.observedChat } : {}),
    ...(payload.failureReason ? { failureReason: payload.failureReason } : {}),
  };
}

function parsePayload(payload: string): PairingPayload {
  try {
    return JSON.parse(payload) as PairingPayload;
  } catch {
    return {};
  }
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
