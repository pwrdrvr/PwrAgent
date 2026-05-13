/**
 * Mattermost slash-command registration & reconciler.
 *
 * Mirrors `discord-commands.ts` for the same surface (`/resume`,
 * `/new`, `/status`, `/detach`, `/monitor`). Mattermost commands are scoped per team —
 * the bot must be a team member, and registration creates a row in
 * the team's `commands` table. Each registered command gets a
 * server-issued `token` (returned in `addCommand`'s response and
 * present on subsequent `getCustomTeamCommands` calls); we cache
 * the token by `${teamId}:${trigger}` and verify it on inbound
 * command POSTs.
 *
 * Tokens are stable across reconciler runs (as long as the command
 * itself isn't deleted), so we don't need to persist them — list
 * + cache on every `start()` is enough.
 */

export type MattermostCommandSpec = {
  /**
   * The full trigger as registered with Mattermost (no leading `/`).
   * Built by `desiredMattermostCommands(prefix)` from the canonical
   * base verb plus the operator-configured prefix — e.g. base
   * `resume` + prefix `pwragent_` → trigger `pwragent_resume`.
   */
  trigger: string;
  displayName: string;
  description: string;
  /** Shown in the `/` menu in Mattermost's composer next to the trigger. */
  autoCompleteDesc: string;
  /** Shown after the trigger as inline placeholder text, e.g. `[--projects | --new]`. */
  autoCompleteHint?: string;
};

export const DEFAULT_MATTERMOST_COMMAND_PREFIX = "pwragent_";

/** Mattermost server-enforced trigger char set (`command.go` source). */
const MATTERMOST_TRIGGER_REGEX = /^[A-Za-z0-9_./-]+$/;
const MATTERMOST_TRIGGER_MAX_LENGTH = 128;

/**
 * Validate and normalize the operator's prefix, falling back to the
 * default if invalid. Empty string is allowed (bare triggers).
 *
 * Server-enforced rules per Mattermost's `Command.IsValid()`:
 *   - full trigger matches `^[A-Za-z0-9_./-]+$`
 *   - full trigger length 1..128
 *   - cannot start with `/`
 */
export function sanitizeMattermostCommandPrefix(
  raw: string | undefined,
  log?: (msg: string, extra?: Record<string, unknown>) => void,
): string {
  if (raw === undefined || raw === DEFAULT_MATTERMOST_COMMAND_PREFIX) {
    return DEFAULT_MATTERMOST_COMMAND_PREFIX;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }
  if (!MATTERMOST_TRIGGER_REGEX.test(trimmed) || trimmed.startsWith("/")) {
    log?.("mattermost: slash-command prefix invalid; falling back to default", {
      provided: raw,
      defaultPrefix: DEFAULT_MATTERMOST_COMMAND_PREFIX,
    });
    return DEFAULT_MATTERMOST_COMMAND_PREFIX;
  }
  return trimmed;
}

type CanonicalCommandBase = {
  base: string;
  displayNameSuffix: string;
  description: string;
  autoCompleteDesc: string;
  autoCompleteHint?: string;
};

/**
 * Canonical command set as base verbs. Match Discord's surface
 * (`resume`, `new`, `status`, `detach`, `monitor`, `help`) so users on different platforms see
 * the same primitives. Add new entries here; the reconciler picks
 * them up automatically once the per-prefix trigger is computed.
 */
const CANONICAL_COMMAND_BASES: readonly CanonicalCommandBase[] = [
  {
    base: "resume",
    displayNameSuffix: "Resume",
    description: "Bind this conversation to a PwrAgent thread.",
    autoCompleteDesc: "Choose a PwrAgent thread to control from this conversation.",
    autoCompleteHint: "[--projects | --new | <args>]",
  },
  {
    base: "new",
    displayNameSuffix: "New",
    description: "Start a new PwrAgent thread from a project.",
    autoCompleteDesc: "Start a new PwrAgent thread from a project.",
    autoCompleteHint: "[--fast | --model <model> | <filter>]",
  },
  {
    base: "status",
    displayNameSuffix: "Status",
    description: "Show the current PwrAgent thread binding and controls.",
    autoCompleteDesc: "Show the current PwrAgent thread binding and controls.",
  },
  {
    base: "detach",
    displayNameSuffix: "Detach",
    description: "Detach this conversation from its current PwrAgent thread.",
    autoCompleteDesc: "Detach this conversation from its current PwrAgent thread.",
  },
  {
    base: "monitor",
    displayNameSuffix: "Monitor",
    description: "Monitor recent PwrAgent threads once per minute.",
    autoCompleteDesc: "Monitor recent PwrAgent threads once per minute.",
  },
  {
    base: "help",
    displayNameSuffix: "Help",
    description: "Show available PwrAgent commands and how to invoke them.",
    autoCompleteDesc: "Show available PwrAgent commands and how to invoke them.",
  },
];

/**
 * Build the desired command set for a given operator-chosen prefix.
 * Skips any base whose composed trigger doesn't pass Mattermost's
 * server-side validation (length / char set) — defensive, since the
 * canonical bases are short and ASCII, but a future addition could
 * accidentally bust the rules.
 */
export function desiredMattermostCommands(
  prefix: string = DEFAULT_MATTERMOST_COMMAND_PREFIX,
): readonly MattermostCommandSpec[] {
  const specs: MattermostCommandSpec[] = [];
  for (const base of CANONICAL_COMMAND_BASES) {
    const trigger = `${prefix}${base.base}`;
    if (
      trigger.length < 1
      || trigger.length > MATTERMOST_TRIGGER_MAX_LENGTH
      || !MATTERMOST_TRIGGER_REGEX.test(trigger)
    ) {
      continue;
    }
    specs.push({
      trigger,
      displayName: `PwrAgent ${base.displayNameSuffix}`,
      description: base.description,
      autoCompleteDesc: base.autoCompleteDesc,
      ...(base.autoCompleteHint ? { autoCompleteHint: base.autoCompleteHint } : {}),
    });
  }
  return specs;
}

/**
 * Recover the canonical base verb from a prefixed trigger so the
 * controller can dispatch on a stable name regardless of how the
 * operator namespaced it. Returns `undefined` if the trigger doesn't
 * end with one of the canonical bases.
 *
 * Slash-command bodies arrive with the full prefixed trigger (e.g.
 * `/pwragent_resume`); we strip the leading slash + the configured
 * prefix to recover `resume`. The text-mention path (`@bot resume`)
 * already uses base verbs, so dispatching on the same names keeps
 * the two paths uniform.
 */
export function baseTriggerForPrefixed(
  command: string,
  prefix: string,
): string | undefined {
  const stripped = command.replace(/^\//, "").toLowerCase();
  const prefixLower = prefix.toLowerCase();
  const withoutPrefix = stripped.startsWith(prefixLower)
    ? stripped.slice(prefixLower.length)
    : stripped;
  return CANONICAL_COMMAND_BASES.find((b) => b.base === withoutPrefix)?.base;
}

/**
 * Subset of Mattermost's `Command` type we read at reconcile time.
 * Kept narrow so tests can fake it without dragging in the full
 * `@mattermost/types` shape.
 */
export type MattermostCommandRecord = {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  url: string;
  method: "P" | "G" | "";
  display_name: string;
  description: string;
  auto_complete: boolean;
  auto_complete_desc: string;
  auto_complete_hint: string;
};

export type MattermostCommandCreateRequest = Omit<MattermostCommandRecord, "id" | "token">;

export type MattermostCommandsApi = {
  /** Returns commands custom to this team that the bot has permission to see. */
  getCustomTeamCommands(teamId: string): Promise<MattermostCommandRecord[]>;
  addCommand(command: MattermostCommandCreateRequest): Promise<MattermostCommandRecord>;
  editCommand(command: MattermostCommandRecord): Promise<MattermostCommandRecord>;
  deleteCommand(id: string): Promise<unknown>;
};

export type MattermostReconcileResult = {
  teamId: string;
  created: string[];
  updated: string[];
  deleted: string[];
  /** Token-by-trigger for the post-reconciliation state, used at validate time. */
  tokensByTrigger: Map<string, string>;
};

/**
 * Build the desired `Command` row for a given team + base callback URL.
 * Called by the reconciler for each entry in `DESIRED_MATTERMOST_COMMANDS`.
 *
 * The command POST endpoint is `${callbackBaseUrl}/command` — same
 * tunnel + port as interactive button callbacks; the listener routes
 * by Content-Type (JSON vs form-encoded), so a single tunnel mapping
 * handles both surfaces.
 */
export function buildMattermostCommandRequest(params: {
  spec: MattermostCommandSpec;
  teamId: string;
  callbackBaseUrl: string;
}): MattermostCommandCreateRequest {
  const url = appendCommandPath(params.callbackBaseUrl);
  return {
    team_id: params.teamId,
    trigger: params.spec.trigger,
    url,
    method: "P",
    display_name: params.spec.displayName,
    description: params.spec.description,
    auto_complete: true,
    auto_complete_desc: params.spec.autoCompleteDesc,
    auto_complete_hint: params.spec.autoCompleteHint ?? "",
    username: "",
    icon_url: "",
  } as MattermostCommandCreateRequest;
}

/**
 * Append `/command` to the configured callback base URL, normalizing
 * trailing slashes so we never produce `…//command`.
 */
export function appendCommandPath(callbackBaseUrl: string): string {
  const trimmed = callbackBaseUrl.replace(/\/+$/, "");
  return `${trimmed}/command`;
}

/**
 * Reconcile slash commands for a single team. Mirrors
 * `reconcileDiscordApplicationCommands`:
 *   - list existing custom commands for the team
 *   - filter to triggers we own (anything in `desired`)
 *   - create missing, update mismatched, delete orphans
 *   - return the post-reconcile token map
 *
 * Defensive: any per-command failure (no permission, race with another
 * client, etc.) is logged and skipped; we don't fail the whole
 * adapter start over a single command.
 */
export async function reconcileMattermostCommands(params: {
  api: MattermostCommandsApi;
  teamId: string;
  callbackBaseUrl: string;
  desired?: readonly MattermostCommandSpec[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<MattermostReconcileResult> {
  const desired = params.desired ?? desiredMattermostCommands();
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const tokensByTrigger = new Map<string, string>();

  const desiredByTrigger = new Map<string, MattermostCommandSpec>();
  for (const spec of desired) {
    desiredByTrigger.set(spec.trigger, spec);
  }

  let existing: MattermostCommandRecord[] = [];
  try {
    existing = await params.api.getCustomTeamCommands(params.teamId);
  } catch (error) {
    params.log?.("mattermost commands: list failed", {
      teamId: params.teamId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      teamId: params.teamId,
      created,
      updated,
      deleted,
      tokensByTrigger,
    };
  }

  const seenTriggers = new Set<string>();

  for (const record of existing) {
    const spec = desiredByTrigger.get(record.trigger);
    if (!spec) {
      continue;
    }
    seenTriggers.add(record.trigger);
    const desiredRequest = buildMattermostCommandRequest({
      spec,
      teamId: params.teamId,
      callbackBaseUrl: params.callbackBaseUrl,
    });
    if (commandMatchesDesired(record, desiredRequest)) {
      tokensByTrigger.set(record.trigger, record.token);
      continue;
    }
    try {
      const next = await params.api.editCommand({
        ...record,
        ...desiredRequest,
      });
      tokensByTrigger.set(record.trigger, next.token);
      updated.push(record.trigger);
    } catch (error) {
      params.log?.("mattermost commands: edit failed", {
        teamId: params.teamId,
        trigger: record.trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep the old token so existing commands keep working.
      tokensByTrigger.set(record.trigger, record.token);
    }
  }

  for (const spec of desired) {
    if (seenTriggers.has(spec.trigger)) {
      continue;
    }
    try {
      const created_ = await params.api.addCommand(
        buildMattermostCommandRequest({
          spec,
          teamId: params.teamId,
          callbackBaseUrl: params.callbackBaseUrl,
        }),
      );
      tokensByTrigger.set(spec.trigger, created_.token);
      created.push(spec.trigger);
    } catch (error) {
      params.log?.("mattermost commands: create failed", {
        teamId: params.teamId,
        trigger: spec.trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // We deliberately DO NOT delete commands we don't recognize — the
  // bot may be sharing the team with other integrations. Deletion is
  // limited to commands whose trigger IS in our desired set but whose
  // record we want to retire. Today there's no retirement path; the
  // hook is here for future use.
  void deleted;

  return {
    teamId: params.teamId,
    created,
    updated,
    deleted,
    tokensByTrigger,
  };
}

function commandMatchesDesired(
  record: MattermostCommandRecord,
  desired: MattermostCommandCreateRequest,
): boolean {
  return (
    record.url === desired.url
    && record.method === desired.method
    && record.display_name === desired.display_name
    && record.description === desired.description
    && record.auto_complete === desired.auto_complete
    && record.auto_complete_desc === desired.auto_complete_desc
    && record.auto_complete_hint === desired.auto_complete_hint
  );
}
