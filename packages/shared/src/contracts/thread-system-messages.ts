import { THREAD_DEPENDENCY_CONDITION_PHRASES } from "./thread-dependencies";
import { parseThreadUrl, type ThreadLinkRef } from "./thread-link";

/*
 * PwrAgent writes two transcript messages for another model to read: the
 * Continue-after prompt that resumes a thread when its dependency fires, and
 * the Thread-delivery breadcrumb a sender keeps for a message it sent to
 * another thread. The transcript collapses both to a one-line summary, so the
 * main process builds them from the constants here and the renderer parses
 * them with the functions here. Parsing the text, rather than adding origin
 * fields, also summarizes messages written before this existed and messages
 * served by an older federated owner.
 */

export const THREAD_DEPENDENCY_PROMPT_INTRO = "PwrAgent resumed this thread because ";
export const THREAD_DEPENDENCY_PROMPT_ANY_MET = "one of its prerequisites was met";
export const THREAD_DEPENDENCY_PROMPT_FAILED = "a prerequisite failed";
export const THREAD_DEPENDENCY_PROMPT_PLAN_LEAD =
  "Do what was planned when this dependency was registered:";
export const THREAD_DEPENDENCY_PROMPT_UNSTARTED_PLAN_LEAD =
  "The work planned for success, not to start now:";

export type ThreadDependencyPromptSummary = {
  outcome: "success" | "failure";
  /** `"Foundation" passes CI`, or a count when several prerequisites are listed. */
  summary: string;
  /** First line of the registered continuation, when there is one. */
  plan?: string;
};

export function summarizeThreadDependencyPrompt(
  text: string,
): ThreadDependencyPromptSummary | undefined {
  const lines = text.split("\n");
  const intro = lines[0] ?? "";
  if (!intro.startsWith(THREAD_DEPENDENCY_PROMPT_INTRO)) return undefined;
  const reason = intro.slice(THREAD_DEPENDENCY_PROMPT_INTRO.length);
  const outcome = reason.startsWith(THREAD_DEPENDENCY_PROMPT_FAILED)
    ? "failure"
    : "success";
  const evidence: string[] = [];
  for (let index = 1; lines[index]?.startsWith("- "); index += 1) {
    evidence.push(lines[index]!.slice(2));
  }
  const planLead = outcome === "success"
    ? THREAD_DEPENDENCY_PROMPT_PLAN_LEAD
    : THREAD_DEPENDENCY_PROMPT_UNSTARTED_PLAN_LEAD;
  const planIndex = lines.indexOf(planLead);
  const plan = planIndex >= 0 ? lines[planIndex + 1]?.trim() : undefined;
  return {
    outcome,
    summary: dependencySummary(outcome, evidence, reason.startsWith(THREAD_DEPENDENCY_PROMPT_ANY_MET)),
    ...(plan ? { plan } : {}),
  };
}

function dependencySummary(
  outcome: ThreadDependencyPromptSummary["outcome"],
  evidence: string[],
  anyMode: boolean,
): string {
  if (evidence.length === 1) {
    const entry = splitEvidence(evidence[0]!);
    if (!entry) return evidence[0]!;
    return outcome === "success"
      ? entry.condition
      : `${entry.condition} — ${entry.reason}`;
  }
  if (outcome === "failure") return "A prerequisite failed";
  if (evidence.length === 0) return "Prerequisites met";
  return anyMode
    ? `One of ${evidence.length} prerequisites met`
    : `${evidence.length} prerequisites met`;
}

/** `"Name" passes CI: CI failed; PR: …` → condition and reason. */
function splitEvidence(line: string): { condition: string; reason: string } | undefined {
  // The name is a quoted title or `Thread <id>`. Find where it ends before
  // looking for the phrase, so a title that contains a phrase cannot match.
  const nameEnd = line.startsWith("\"")
    ? line.indexOf("\" ", 1) + 1
    : line.startsWith("Thread ") ? line.indexOf(" ", "Thread ".length) : -1;
  if (nameEnd <= 0) return undefined;
  for (const phrase of Object.values(THREAD_DEPENDENCY_CONDITION_PHRASES)) {
    const marker = ` ${phrase}: `;
    const index = line.indexOf(marker, nameEnd);
    if (index === nameEnd) {
      const rest = line.slice(index + marker.length);
      return {
        condition: line.slice(0, index + marker.length - 2),
        reason: rest.split("; ")[0]!,
      };
    }
  }
  return undefined;
}

export const THREAD_CORRESPONDENCE_STATES = [
  "sending", "queued", "started", "failed", "cancelled", "held",
] as const;
export type ThreadCorrespondenceState = (typeof THREAD_CORRESPONDENCE_STATES)[number];

export const THREAD_CORRESPONDENCE_STATE_LABELS: Readonly<Record<ThreadCorrespondenceState, string>> = {
  sending: "Send outcome unknown",
  queued: "Queued (last confirmed)",
  started: "Receiving thread started work",
  failed: "Failed to send",
  cancelled: "Cancelled",
  held: "Held for retry",
};

/** First line of a delivery breadcrumb. `destinationLink` is a thread Markdown link. */
export function buildThreadCorrespondenceHeading(
  destinationLink: string,
  state: ThreadCorrespondenceState,
): string {
  return `**Message to ${destinationLink}** · ${THREAD_CORRESPONDENCE_STATE_LABELS[state]}`;
}

export type ParsedThreadCorrespondenceMessage = {
  destination?: ThreadLinkRef & { title?: string };
  state?: ThreadCorrespondenceState;
  heading: string;
  /** The message as sent, without the heading. */
  body: string;
};

const CORRESPONDENCE_HEADING = /^\*\*Message to (.*)\*\* · (.+)$/;
const MARKDOWN_LINK = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)$/;

export function parseThreadCorrespondenceMessage(
  text: string,
): ParsedThreadCorrespondenceMessage | undefined {
  const newline = text.indexOf("\n");
  const heading = newline < 0 ? text : text.slice(0, newline);
  const match = CORRESPONDENCE_HEADING.exec(heading);
  if (!match) return undefined;
  const link = MARKDOWN_LINK.exec(match[1]!);
  const ref = link ? parseThreadUrl(link[2]!) : undefined;
  const title = link?.[1]!.replace(/\\(.)/g, "$1").trim();
  const state = THREAD_CORRESPONDENCE_STATES.find(
    (candidate) => THREAD_CORRESPONDENCE_STATE_LABELS[candidate] === match[2],
  );
  return {
    heading,
    body: newline < 0 ? "" : text.slice(newline + 1).replace(/^\n/, ""),
    ...(ref ? { destination: { ...ref, ...(title ? { title } : {}) } } : {}),
    ...(state ? { state } : {}),
  };
}

/** One display line, bounded by Unicode code points without cutting a surrogate pair. */
export function threadNotificationSnippet(text: string, limit = 240): string {
  const points = Array.from(text.replace(/\s+/gu, " ").trim());
  return points.length <= limit ? points.join("") : `${points.slice(0, limit - 1).join("")}…`;
}
