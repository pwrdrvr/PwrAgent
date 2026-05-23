import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AutomationTimelineCard,
} from "@pwragent/shared";

export const AUTOMATION_CARD_ENTRY_PREFIX = "automation-card-";

export function buildAutomationCardActivityEntries(
  cards: AutomationTimelineCard[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!cards || cards.length === 0) {
    return [];
  }
  return cards.map((card) => ({
    type: "activity",
    id: `${AUTOMATION_CARD_ENTRY_PREFIX}${card.runId}`,
    summary: `Automation - ${card.summary}`,
    createdAt: card.occurredAt,
    tone:
      card.status === "failed" || card.status === "cancelled"
        ? "warning"
        : undefined,
    status: toActivityStatus(card.status),
    details: [
      ...(card.details?.trim()
        ? [
            {
              id: `${card.runId}:details`,
              kind: "read" as const,
              label: card.details.trim(),
            },
          ]
        : []),
      {
        id: `${card.runId}:source`,
        kind: "read",
        label: `Source: ${card.automationName}`,
      },
      {
        id: `${card.runId}:status`,
        kind: "read",
        label: `Run status: ${card.status}`,
      },
    ],
  }));
}

export function injectAutomationCards(
  entries: AppServerThreadEntry[],
  cards: AutomationTimelineCard[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildAutomationCardActivityEntries(cards);
  if (synthetic.length === 0) {
    return entries;
  }
  const merged: AppServerThreadEntry[] = [...entries, ...synthetic];
  merged.sort((left, right) => {
    const leftAt = left.createdAt ?? 0;
    const rightAt = right.createdAt ?? 0;
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    const leftIsCard = left.id.startsWith(AUTOMATION_CARD_ENTRY_PREFIX);
    const rightIsCard = right.id.startsWith(AUTOMATION_CARD_ENTRY_PREFIX);
    if (leftIsCard === rightIsCard) {
      return 0;
    }
    return leftIsCard ? 1 : -1;
  });
  return merged;
}

function toActivityStatus(
  status: AutomationTimelineCard["status"],
): AppServerThreadActivityEntry["status"] {
  if (status === "failed" || status === "cancelled") {
    return status;
  }
  return "completed";
}
