import type {
  DesktopAuthorizedContact,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";

/**
 * Compute a config patch for a Telegram/Discord save action that includes
 * ONLY the fields whose new value differs from the snapshot the user opened.
 *
 * The Settings UI builds candidate objects shaped like the snapshot (each
 * field has a `.value`). Without this filter, every save would emit every
 * field — including env-resolved ones the user never touched — which leaks
 * environment overrides into the config file.
 *
 * Rules:
 *   - A field is included only when its new `.value` is not equal to the
 *     snapshot's `.value`.
 *   - Env-overridden fields whose value the user did not change are dropped.
 *   - If the user did change an env-overridden field, the new value is
 *     written to the config file (env still wins on read until the env var
 *     is unset, but the user's intent is recorded).
 */
export function buildTelegramPatchDelta(
  snapshot: DesktopSettingsSnapshot["messaging"]["telegram"],
  candidate: DesktopSettingsSnapshot["messaging"]["telegram"],
): NonNullable<NonNullable<DesktopSettingsConfigPatch["messaging"]>["telegram"]> | undefined {
  const patch: NonNullable<
    NonNullable<DesktopSettingsConfigPatch["messaging"]>["telegram"]
  > = {};

  if (snapshot.enabled.value !== candidate.enabled.value) {
    patch.enabled = candidate.enabled.value;
  }
  if (snapshot.streamingResponses.value !== candidate.streamingResponses.value) {
    patch.streamingResponses = candidate.streamingResponses.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedUserIds.value,
      candidate.authorizedUserIds.value,
    )
  ) {
    patch.authorizedUserIds = candidate.authorizedUserIds.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedSupergroups.value,
      candidate.authorizedSupergroups.value,
    )
  ) {
    patch.authorizedSupergroups = candidate.authorizedSupergroups.value;
  }

  return Object.keys(patch).length === 0 ? undefined : patch;
}

export function buildDiscordPatchDelta(
  snapshot: DesktopSettingsSnapshot["messaging"]["discord"],
  candidate: DesktopSettingsSnapshot["messaging"]["discord"],
): NonNullable<NonNullable<DesktopSettingsConfigPatch["messaging"]>["discord"]> | undefined {
  const patch: NonNullable<
    NonNullable<DesktopSettingsConfigPatch["messaging"]>["discord"]
  > = {};

  if (snapshot.enabled.value !== candidate.enabled.value) {
    patch.enabled = candidate.enabled.value;
  }
  if (snapshot.streamingResponses.value !== candidate.streamingResponses.value) {
    patch.streamingResponses = candidate.streamingResponses.value;
  }
  if (snapshot.applicationId.value !== candidate.applicationId.value) {
    patch.applicationId = candidate.applicationId.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedUserIds.value,
      candidate.authorizedUserIds.value,
    )
  ) {
    patch.authorizedUserIds = candidate.authorizedUserIds.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedGuilds.value,
      candidate.authorizedGuilds.value,
    )
  ) {
    patch.authorizedGuilds = candidate.authorizedGuilds.value;
  }

  return Object.keys(patch).length === 0 ? undefined : patch;
}

export function buildMattermostPatchDelta(
  snapshot: DesktopSettingsSnapshot["messaging"]["mattermost"],
  candidate: DesktopSettingsSnapshot["messaging"]["mattermost"],
): NonNullable<NonNullable<DesktopSettingsConfigPatch["messaging"]>["mattermost"]> | undefined {
  const patch: NonNullable<
    NonNullable<DesktopSettingsConfigPatch["messaging"]>["mattermost"]
  > = {};

  if (snapshot.enabled.value !== candidate.enabled.value) {
    patch.enabled = candidate.enabled.value;
  }
  if (snapshot.streamingResponses.value !== candidate.streamingResponses.value) {
    patch.streamingResponses = candidate.streamingResponses.value;
  }
  if (snapshot.serverUrl.value !== candidate.serverUrl.value) {
    patch.serverUrl = candidate.serverUrl.value;
  }
  if (snapshot.callbackBaseUrl.value !== candidate.callbackBaseUrl.value) {
    patch.callbackBaseUrl = candidate.callbackBaseUrl.value;
  }
  if (snapshot.slashCommandPrefix.value !== candidate.slashCommandPrefix.value) {
    patch.slashCommandPrefix = candidate.slashCommandPrefix.value;
  }
  if (
    snapshot.registerSlashCommands.value !== candidate.registerSlashCommands.value
  ) {
    patch.registerSlashCommands = candidate.registerSlashCommands.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedUserIds.value,
      candidate.authorizedUserIds.value,
    )
  ) {
    patch.authorizedUserIds = candidate.authorizedUserIds.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedTeams.value,
      candidate.authorizedTeams.value,
    )
  ) {
    patch.authorizedTeams = candidate.authorizedTeams.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedConversations.value,
      candidate.authorizedConversations.value,
    )
  ) {
    patch.authorizedConversations = candidate.authorizedConversations.value;
  }

  return Object.keys(patch).length === 0 ? undefined : patch;
}

export function buildSlackPatchDelta(
  snapshot: DesktopSettingsSnapshot["messaging"]["slack"],
  candidate: DesktopSettingsSnapshot["messaging"]["slack"],
): NonNullable<NonNullable<DesktopSettingsConfigPatch["messaging"]>["slack"]> | undefined {
  const patch: NonNullable<
    NonNullable<DesktopSettingsConfigPatch["messaging"]>["slack"]
  > = {};

  if (snapshot.enabled.value !== candidate.enabled.value) {
    patch.enabled = candidate.enabled.value;
  }
  if (snapshot.streamingResponses.value !== candidate.streamingResponses.value) {
    patch.streamingResponses = candidate.streamingResponses.value;
  }
  if (snapshot.workspaceUrl.value !== candidate.workspaceUrl.value) {
    patch.workspaceUrl = candidate.workspaceUrl.value;
  }
  if (snapshot.inboundMode.value !== candidate.inboundMode.value) {
    patch.inboundMode = candidate.inboundMode.value;
  }
  if (snapshot.slashCommandPrefix.value !== candidate.slashCommandPrefix.value) {
    patch.slashCommandPrefix = candidate.slashCommandPrefix.value;
  }
  if (
    snapshot.registerSlashCommands.value !== candidate.registerSlashCommands.value
  ) {
    patch.registerSlashCommands = candidate.registerSlashCommands.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedUserIds.value,
      candidate.authorizedUserIds.value,
    )
  ) {
    patch.authorizedUserIds = candidate.authorizedUserIds.value;
  }
  if (
    !authorizedContactArrayEqual(
      snapshot.authorizedWorkspaces.value,
      candidate.authorizedWorkspaces.value,
    )
  ) {
    patch.authorizedWorkspaces = candidate.authorizedWorkspaces.value;
  }

  return Object.keys(patch).length === 0 ? undefined : patch;
}

function authorizedContactArrayEqual(
  a: readonly DesktopAuthorizedContact[],
  b: readonly DesktopAuthorizedContact[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.id !== b[i]?.id || a[i]?.displayName !== b[i]?.displayName) {
      return false;
    }
  }
  return true;
}
