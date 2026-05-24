import type { AutomationRunOutputDecision } from "@pwragent/shared";

export function parseAutomationOutputDecision(
  finalText: string | undefined,
): AutomationRunOutputDecision | undefined {
  if (!finalText?.trim()) return undefined;
  const candidate = extractJsonObject(finalText);
  if (!candidate) {
    return {
      kind: "parse_failed",
      summary: firstLine(finalText),
    };
  }
  try {
    const parsed = JSON.parse(candidate) as {
      decision?: unknown;
      details?: unknown;
      post_card?: unknown;
      summary?: unknown;
    };
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : firstLine(finalText);
    const details =
      typeof parsed.details === "string" && parsed.details.trim()
        ? parsed.details.trim()
        : undefined;
    if (parsed.decision === "quiet" || parsed.post_card === false) {
      return { kind: "quiet", summary, details };
    }
    if (parsed.decision === "post_card" || parsed.post_card === true) {
      return {
        kind: "post_card",
        summary: summary ?? "Automation completed.",
        details,
      };
    }
    return {
      kind: "parse_failed",
      summary,
      details,
    };
  } catch {
    return {
      kind: "parse_failed",
      summary: firstLine(finalText),
    };
  }
}

export function renderAutomationOutputForMessaging(
  finalText: string | undefined,
): string | undefined {
  const trimmed = finalText?.trim();
  if (!trimmed) return undefined;

  const outputDecision = parseAutomationOutputDecision(trimmed);
  if (outputDecision?.kind === "quiet") {
    return undefined;
  }
  if (outputDecision?.kind === "post_card") {
    return renderAutomationDecisionForMessaging(outputDecision);
  }
  return trimmed;
}

export function renderAutomationDecisionForMessaging(
  outputDecision: AutomationRunOutputDecision | undefined,
): string | undefined {
  if (outputDecision?.kind === "quiet") {
    return undefined;
  }
  if (outputDecision?.kind === "post_card") {
    return [outputDecision.summary, outputDecision.details]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }
  return undefined;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/).find((candidate) => candidate.trim());
  return line?.trim();
}

function extractJsonObject(value: string): string | undefined {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return undefined;
}
