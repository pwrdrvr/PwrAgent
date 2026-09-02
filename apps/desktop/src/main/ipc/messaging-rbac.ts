import { ipcMain } from "electron";

import {
  RBAC_BUILT_IN_ROLE_IDS,
  RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE,
  roleIsDangerous,
  type DeleteRbacAttachmentRequest,
  type DeleteRbacAttachmentResponse,
  type DeleteRbacRoleRequest,
  type DeleteRbacRoleResponse,
  type MessagingChannelKind,
  type ReadRbacKnownSubjectsResponse,
  type ReadRbacPolicyResponse,
  type RbacAttachment,
  type RbacKnownSubject,
  type SetRbacEnforcedRequest,
  type SetRbacEnforcedResponse,
  type WriteRbacAttachmentRequest,
  type WriteRbacAttachmentResponse,
  type WriteRbacRoleRequest,
  type WriteRbacRoleResponse,
} from "@pwragent/shared";

import {
  MESSAGING_RBAC_DELETE_ATTACHMENT_CHANNEL,
  MESSAGING_RBAC_DELETE_ROLE_CHANNEL,
  MESSAGING_RBAC_READ_POLICY_CHANNEL,
  MESSAGING_RBAC_READ_SUBJECTS_CHANNEL,
  MESSAGING_RBAC_SET_ENFORCED_CHANNEL,
  MESSAGING_RBAC_WRITE_ATTACHMENT_CHANNEL,
  MESSAGING_RBAC_WRITE_ROLE_CHANNEL,
} from "../../shared/ipc";
import { getRbacPolicyService } from "../messaging/rbac-policy-service";
import { getDesktopConfigStore } from "../settings/desktop-settings-singleton";

/**
 * IPC surface for the Access Control settings pane. The renderer speaks only
 * `@pwragent/shared` contracts; all policy reads/writes cross this bridge.
 */
export function registerMessagingRbacIpcHandlers(): void {
  ipcMain.removeHandler(MESSAGING_RBAC_READ_POLICY_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_READ_POLICY_CHANNEL,
    async (): Promise<ReadRbacPolicyResponse> =>
      getRbacPolicyService().read(),
  );

  ipcMain.removeHandler(MESSAGING_RBAC_READ_SUBJECTS_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_READ_SUBJECTS_CHANNEL,
    async (): Promise<ReadRbacKnownSubjectsResponse> => ({
      subjects: readKnownSubjects(),
    }),
  );

  ipcMain.removeHandler(MESSAGING_RBAC_WRITE_ROLE_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_WRITE_ROLE_CHANNEL,
    async (_event, request: WriteRbacRoleRequest): Promise<WriteRbacRoleResponse> => {
      // Two-factor: adding the escalation-equivalent permission to a role
      // requires the operator to type the exact acknowledgment phrase.
      if (
        roleIsDangerous(request.role.permissions) &&
        request.fullAccessAcknowledgment?.trim() !==
          RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE
      ) {
        return {
          ok: false,
          error:
            "Granting Codex Full Access to a role requires typing the confirmation phrase.",
        };
      }
      return getRbacPolicyService().upsertRole(request.role);
    },
  );

  ipcMain.removeHandler(MESSAGING_RBAC_DELETE_ROLE_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_DELETE_ROLE_CHANNEL,
    async (_event, request: DeleteRbacRoleRequest): Promise<DeleteRbacRoleResponse> =>
      getRbacPolicyService().deleteRole(request.roleId),
  );

  ipcMain.removeHandler(MESSAGING_RBAC_WRITE_ATTACHMENT_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_WRITE_ATTACHMENT_CHANNEL,
    async (
      _event,
      request: WriteRbacAttachmentRequest,
    ): Promise<WriteRbacAttachmentResponse> =>
      getRbacPolicyService().upsertAttachment(request.attachment),
  );

  ipcMain.removeHandler(MESSAGING_RBAC_DELETE_ATTACHMENT_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_DELETE_ATTACHMENT_CHANNEL,
    async (
      _event,
      request: DeleteRbacAttachmentRequest,
    ): Promise<DeleteRbacAttachmentResponse> =>
      getRbacPolicyService().deleteAttachment(request.subject),
  );

  ipcMain.removeHandler(MESSAGING_RBAC_SET_ENFORCED_CHANNEL);
  ipcMain.handle(
    MESSAGING_RBAC_SET_ENFORCED_CHANNEL,
    async (_event, request: SetRbacEnforcedRequest): Promise<SetRbacEnforcedResponse> => {
      // Enabling for the first time seeds a non-destructive starting policy:
      // every currently-authorized actor becomes Admin (today's behavior), and
      // the wide bucket subjects are surfaced as Admin so the operator can see
      // and down-scope them. The service only applies the seed when the policy
      // has no attachments yet, so re-toggling never clobbers edits.
      const synthesized =
        request.enforced && request.synthesizedAttachments === undefined
          ? synthesizeAdminAttachments()
          : request.synthesizedAttachments;
      return getRbacPolicyService().setEnforced(request.enforced, synthesized);
    },
  );
}

const PLATFORM_CONFIG_KEYS: Array<{
  key:
    | "telegram"
    | "discord"
    | "mattermost"
    | "slack"
    | "feishu"
    | "line";
  platform: MessagingChannelKind;
}> = [
  { key: "telegram", platform: "telegram" },
  { key: "discord", platform: "discord" },
  { key: "mattermost", platform: "mattermost" },
  { key: "slack", platform: "slack" },
  { key: "feishu", platform: "feishu" },
  { key: "line", platform: "line" },
];

/**
 * Every subject PwrAgent knows about from messaging config: named authorized
 * users per platform, plus the wide Slack bucket subjects when their access
 * mode is open.
 */
function readKnownSubjects(): RbacKnownSubject[] {
  const messaging = getDesktopConfigStore().read("messaging");
  const subjects: RbacKnownSubject[] = [];

  for (const { key, platform } of PLATFORM_CONFIG_KEYS) {
    const platformConfig = messaging[key];
    for (const contact of platformConfig?.authorizedUserIds ?? []) {
      subjects.push({
        subject: { kind: "actor", platform, actorId: contact.id },
        displayName: contact.displayName,
      });
    }
  }

  const slack = messaging.slack;
  if (slack?.channelUserAccessMode === "any_channel_user") {
    subjects.push({
      subject: { kind: "bucket", platform: "slack", bucket: "channel_any_user" },
      displayName: "Any user in an authorized Slack channel",
      bucket: true,
    });
  }
  if (slack?.dmAccessMode === "any_workspace_user") {
    subjects.push({
      subject: {
        kind: "bucket",
        platform: "slack",
        bucket: "dm_any_workspace_user",
      },
      displayName: "Any Slack workspace user (DM)",
      bucket: true,
    });
  }

  return subjects;
}

/** Non-destructive migration seed: every known subject → Admin. */
function synthesizeAdminAttachments(): RbacAttachment[] {
  return readKnownSubjects().map((known) => ({
    subject: known.subject,
    roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
    ...(known.displayName ? { displayName: known.displayName } : {}),
  }));
}
