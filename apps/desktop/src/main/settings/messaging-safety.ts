export function requireMessagingSafetyAcknowledgment(acknowledgedAt: unknown): void {
  if (typeof acknowledgedAt !== "string" || !acknowledgedAt.trim()) {
    throw new Error(
      "Review and acknowledge the messaging safety principles in Settings → Messaging before enabling a provider or saving messaging credentials.",
    );
  }
}
