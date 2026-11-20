/**
 * Display text for the model-routing notices a backend reports during a turn:
 * a reroute to a different model and a request for account verification.
 * Unknown values come from a newer backend; they stay readable instead of
 * being dropped.
 */

const REROUTE_REASONS: Record<string, string> = {
  highRiskCyberActivity: "possible high-risk cybersecurity activity",
};

const VERIFICATIONS: Record<string, { label: string; detail: string }> = {
  trustedAccessForCyber: {
    label: "Trusted Access for Cyber",
    // Codex's own wording for this request.
    detail:
      "Your conversations have multiple flags for possible cybersecurity risk."
      + " Responses may take longer because extra safety checks are on."
      + " To get authorized for security work, join the Trusted Access for Cyber"
      + " program: https://chatgpt.com/cyber",
  },
};

export function describeModelRerouteReason(reason: string): string {
  return REROUTE_REASONS[reason] ?? humanizeIdentifier(reason);
}

export function describeModelReroute(params: {
  fromModel: string;
  toModel: string;
  reason: string;
}): string {
  const reason = describeModelRerouteReason(params.reason);
  return `Rerouted from ${params.fromModel} to ${params.toModel}`
    + (reason ? ` because of ${reason}` : "");
}

export function describeModelVerification(verification: string): {
  label: string;
  detail: string;
} {
  const known = VERIFICATIONS[verification];
  if (known) return known;
  const label = humanizeIdentifier(verification) || "account verification";
  return {
    label,
    detail: `Codex asked for additional account verification: ${label}.`,
  };
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}
