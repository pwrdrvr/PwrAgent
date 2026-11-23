import type { ThreadSubAgentSummary } from "./contracts/navigation";
import { graphemePrefix } from "./text-graphemes";
import { shortenDerivedThreadTitle } from "./thread-titles";

const MAX_TITLE_LENGTH = 48;
const LEADING_INSTRUCTION = /^(?:please\s+)?(?:monitor|watch|track|poll(?:\s+for)?|wait\s+for)\s+/i;
const FOLLOW_UP_INSTRUCTION = / (?:until\b|after push(?:ing)?\b|and (?:report|notify|wake)\b)/i;
const PULL_REQUEST = /(?:\b(?:pr|pull request)\s+#?|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/|\bgh\s+pr\s+checks\s+#?)(\d+)\b/i;
const CI_CHECK = /\b(?:ci|continuous\s+integration|(?:status|required)\s+checks?|workflow\s+runs?|gh\s+pr\s+checks)\b/i;
const PACKAGE_SCRIPT = /\b(?:pnpm|npm|yarn|bun) (?:(?:--filter[= ]|-C )([\w@./-]+) )?(?:run )?((?:build|check|lint|test|typecheck|verify)(?::[\w-]+)*)(?=$|[ `'";|&<>()]|[.,!?](?= |$))/i;
const LABELED_ID = /\b(?:at\s+)?(?:commit|sha|(?:job|run|session) id)\s*[:#]?\s*`?[\da-f]{7,64}\b`?/gi;
const LONG_ID = /`?\b(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[\da-f]{12,})\b`?/gi;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function deriveTaskMonitorDisplayTitle(task: string): string {
  const line = task.trimStart().split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").trimEnd();
  const subject = line
    .replace(LEADING_INSTRUCTION, "")
    .split(FOLLOW_UP_INSTRUCTION, 1)[0]!;
  const request = PULL_REQUEST.exec(subject);
  const requestNumber = request?.[1];
  if (request && requestNumber && requestNumber.length <= 12) {
    const checksAfterNumber = /^ checks\b/i.test(subject.slice(request.index + request[0].length));
    return `PR ${requestNumber}${checksAfterNumber || CI_CHECK.test(task) ? " CI" : ""}`;
  }

  const command = PACKAGE_SCRIPT.exec(subject);
  if (command) {
    const project = command[1]?.split("/").at(-1);
    const action = command[2]!.replace(/^[^:]+/, (script) => capitalize(script.toLowerCase()));
    if (!project) return action;
    return shortenMonitorTitle(`${capitalize(project)} ${action}`);
  }

  return shortenMonitorTitle(subject.replace(LABELED_ID, "").replace(LONG_ID, ""));
}

function shortenMonitorTitle(text: string): string {
  const title = shortenDerivedThreadTitle(text);
  if (!title) return "Job Monitor";
  if (title.length <= MAX_TITLE_LENGTH) return title;
  const prefix = graphemePrefix(title, MAX_TITLE_LENGTH - 1);
  const wordBreak = prefix.lastIndexOf(" ");
  const shortened = wordBreak >= 24 ? prefix.slice(0, wordBreak) : prefix;
  return shortened ? `${shortened.trimEnd()}…` : "Job Monitor";
}

/** Older cards and peers can supply only the original task. */
export function taskMonitorDisplayTitle(
  card: Pick<ThreadSubAgentSummary, "monitorId" | "task" | "displayTitle">,
): string | undefined {
  if (!card.monitorId.startsWith("monitor-")) return undefined;
  return card.displayTitle ?? deriveTaskMonitorDisplayTitle(card.task);
}
