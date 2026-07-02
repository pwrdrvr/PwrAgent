import {
  validateSlackTeamId,
  type MessagingPairingApprovalTarget,
} from "@pwragent/shared";

/**
 * The observed-chat facts the approval helpers need. Both surfaces can supply
 * this: Settings from `entry.observedChat`, the wizard from its local state.
 */
export type SlackObservedChatFacts = {
  kind?: string;
  bucketId?: string;
};

/**
 * Shared Slack pairing-approval helpers used by both the Settings pairing card
 * and the onboarding wizard, so the two surfaces can never disagree about which
 * facets are approvable, what the buttons say, or how "Approve all" sequences
 * the per-facet approvals.
 */

/** Button captions for each approval facet, in approvable and approved states. */
export const SLACK_APPROVAL_TARGET_LABELS: Record<
  MessagingPairingApprovalTarget,
  { approve: string; approved: string }
> = {
  actor: { approve: "Approve user", approved: "User approved" },
  conversation: { approve: "Approve channel", approved: "Channel approved" },
  team: { approve: "Approve team", approved: "Team approved" },
};

/**
 * Which approval targets apply to a Slack observed request: always the user,
 * the channel unless it's a DM, and the team only when a *valid* workspace ID
 * (starts with T) was observed — a channel/DM id that leaked into `bucketId`
 * must not offer a bogus "Approve team".
 */
export function slackApplicableApprovalTargets(
  observed: SlackObservedChatFacts | undefined,
): MessagingPairingApprovalTarget[] {
  const targets: MessagingPairingApprovalTarget[] = ["actor"];
  if (observed?.kind !== "dm") {
    targets.push("conversation");
  }
  if (observed?.bucketId && validateSlackTeamId(observed.bucketId).ok) {
    targets.push("team");
  }
  return targets;
}

/**
 * The ordered steps for an "Approve all" / finish action: every not-yet-approved
 * applicable facet, consuming the request on the final step so the card clears.
 * Falls back to a consuming actor approval when everything is already approved.
 */
export function slackApprovalSequence(
  observed: SlackObservedChatFacts | undefined,
  approvedTargets: readonly MessagingPairingApprovalTarget[],
): Array<{ target: MessagingPairingApprovalTarget; consume: boolean }> {
  const remaining = slackApplicableApprovalTargets(observed).filter(
    (target) => !approvedTargets.includes(target),
  );
  const sequence: MessagingPairingApprovalTarget[] =
    remaining.length > 0 ? remaining : ["actor"];
  return sequence.map((target, index) => ({
    target,
    consume: index === sequence.length - 1,
  }));
}
