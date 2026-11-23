import type { MessagingBindingRecord, MessagingInboundEvent, MessagingWorkspaceAdminEvidence } from "@pwragent/messaging-interface";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import {
  AGENT_TRUST_PROPERTY_MAX_AGE_MS,
  evaluateAgentTrustPolicy,
  type AgentTrustDecision,
  type AgentTrustEvidence,
} from "@pwragent/shared/contracts/agent-trust-policy";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { setTimeout as delay } from "node:timers/promises";

export type MessagingAgentTrustTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  policy: unknown;
  remote?: boolean;
};

export type MessagingAgentTrustAdmission = (target: MessagingAgentTrustTarget) => Promise<boolean>;
export type BoundMessagingAgentTrustAdmission = (event: MessagingInboundEvent, binding: MessagingBindingRecord) => Promise<boolean>;

const AUDIT_COOLDOWN_MS = 120_000;
const MAX_PENDING_PROPERTY_LOOKUPS = 4;

// One budget across controllers in the process that holds the messaging lease.
export class MessagingAgentTrustAudit {
  private nextWrite = -Infinity;

  record(params: {
    log: () => MessagingActivityStorage | undefined;
    now: number;
    event: MessagingInboundEvent;
    target: MessagingAgentTrustTarget;
    reason: string;
  }): boolean {
    if (params.now < this.nextWrite) return false;
    this.nextWrite = params.now + AUDIT_COOLDOWN_MS;
    const { log, now, event, target, reason } = params;
    try {
      log()?.record({
        platform: event.channel.channel,
        kind: "inbound-rejected",
        backend: target.backend,
        threadId: target.threadId,
        conversationId: event.channel.conversation.id,
        createdAt: now,
        summary: "Agent invocation declined by its trust policy.",
        payload: { rejectionStage: "agent-trust", rejectionReason: reason },
      });
    } catch {
      // Audit failures cannot turn a rejection into an allowance.
    }
    return true;
  }
}

export class MessagingAgentTrust {
  private pendingPropertyLookups = 0;
  private readonly eventEvidence = new WeakMap<MessagingInboundEvent, Promise<MessagingWorkspaceAdminEvidence | undefined>>();

  constructor(private readonly options: {
    now: () => number;
    resolveWorkspaceAdmin?: (event: MessagingInboundEvent) => Promise<MessagingWorkspaceAdminEvidence | undefined>;
  }) {}

  async evaluate(policy: unknown, event: MessagingInboundEvent, roleIds?: readonly string[]): Promise<AgentTrustDecision> {
    const evidence: AgentTrustEvidence = {
      provider: event.channel.channel,
      // The pre-#258 runtime only has the legacy namespace. A retained
      // provider account identity is never substituted for a connection ID.
      conversation: event.channel.conversation,
      actorId: event.actor.platformUserId,
      roleIds,
    };
    const initial = evaluateAgentTrustPolicy(policy, evidence, this.options.now());
    if (initial.allowed || initial.reason !== "actor-property") return initial;
    let lookup = this.eventEvidence.get(event);
    if (!lookup) {
      lookup = this.getWorkspaceAdmin(event);
      this.eventEvidence.set(event, lookup);
    }
    const workspaceAdmin = await lookup;
    return evaluateAgentTrustPolicy(policy, { ...evidence, workspaceAdmin }, this.options.now());
  }

  private async getWorkspaceAdmin(event: MessagingInboundEvent): Promise<MessagingWorkspaceAdminEvidence | undefined> {
    const resolve = this.options.resolveWorkspaceAdmin;
    if (!resolve || this.pendingPropertyLookups >= MAX_PENDING_PROPERTY_LOOKUPS) return undefined;
    const deadline = new AbortController();
    this.pendingPropertyLookups++;
    const evidence = Promise.resolve().then(() => resolve(event)).catch(() => undefined).finally(() => {
      this.pendingPropertyLookups--;
    });
    try {
      return await Promise.race([
        evidence,
        delay(AGENT_TRUST_PROPERTY_MAX_AGE_MS, undefined, { signal: deadline.signal }).catch(() => undefined),
      ]);
    } finally {
      deadline.abort();
    }
  }
}
