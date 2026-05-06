/**
 * Mattermost slash-command registration & reconciler.
 *
 * Mirrors `discord-commands.ts` for the same surface (`/resume`,
 * `/status`, `/detach`). Mattermost commands are scoped per team —
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
  trigger: string;
  displayName: string;
  description: string;
  /** Shown in the `/` menu in Mattermost's composer next to the trigger. */
  autoCompleteDesc: string;
  /** Shown after the trigger as inline placeholder text, e.g. `[--projects | --new]`. */
  autoCompleteHint?: string;
};

/**
 * Canonical command set. Match Discord's surface (`resume`, `status`,
 * `detach`) so users on different platforms see the same primitives.
 * Add new commands here; the reconciler picks them up automatically.
 */
export const DESIRED_MATTERMOST_COMMANDS: readonly MattermostCommandSpec[] = [
  {
    trigger: "resume",
    displayName: "PwrAgent Resume",
    description: "Bind this conversation to a PwrAgent thread.",
    autoCompleteDesc: "Choose a PwrAgent thread to control from this conversation.",
    autoCompleteHint: "[--projects | --new | <args>]",
  },
  {
    trigger: "status",
    displayName: "PwrAgent Status",
    description: "Show the current PwrAgent thread binding and controls.",
    autoCompleteDesc: "Show the current PwrAgent thread binding and controls.",
  },
  {
    trigger: "detach",
    displayName: "PwrAgent Detach",
    description: "Detach this conversation from its current PwrAgent thread.",
    autoCompleteDesc: "Detach this conversation from its current PwrAgent thread.",
  },
];

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
  const desired = params.desired ?? DESIRED_MATTERMOST_COMMANDS;
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
