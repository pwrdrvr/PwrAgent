import { resolveEffectivePermissions, type MessagingPermissionId } from "@pwragent/shared/contracts/rbac";
import type { MessagingRbacPolicyProvider } from "../../messaging/rbac-policy-service";
import { MessagingActivityLog } from "../../storage/messaging-activity-log";
import { SqliteMessagingRequestStore } from "../../state/messaging-request-store";
import { messagingInboundHarness } from "./messaging-inbound-harness";

export async function messagingAccessHarness(channel: "telegram" | "discord" = "telegram", shared = false, route: "binding" | "default-agent" = "binding") {
  const f = await messagingInboundHarness({ channel, shared, route });
  const policy = { enforcing: true, named: new Set<MessagingPermissionId>(), bucket: new Set<MessagingPermissionId>() };
  const reads: string[] = [];
  const resolve: MessagingRbacPolicyProvider["resolve"] = input => {
    reads.push("resolve");
    return resolveEffectivePermissions({ ...input, platform: channel,
      roles: [{ id: "named", name: "Named fixture", builtIn: false, permissions: [...policy.named] }, { id: "bucket", name: "Bucket fixture", builtIn: false, permissions: [...policy.bucket] }],
      attachments: [
        { subject: { kind: "actor", platform: channel, actorId: "fixture-actor" }, roleIds: ["named"] },
        { subject: { kind: "bucket", platform: channel, bucket: shared ? "channel_any_user" : "dm_any_workspace_user" }, roleIds: ["bucket"] },
      ],
    });
  };
  f.controllerOptions.rbacPolicy = {
    isEnforcing() { reads.push("enforcing"); return policy.enforcing; }, resolve,
    resolveIfEnforcing(input) { reads.push("atomic"); return policy.enforcing ? resolve(input) : null; },
  };
  const activity = new MessagingActivityLog(f.db);
  f.controllerOptions.activityLog = () => activity;
  const requests = new SqliteMessagingRequestStore(f.db.raw);
  f.controllerOptions.requestStore = requests;
  const source = requests.remember({ agent: { backend: "codex", threadId: "fixture-thread" }, bindingId: "fixture-binding",
    connectionId: "fixture-connection", event: f.event(),
  })!;
  return { ...f, policy, reads, activity, requests, source };
}
