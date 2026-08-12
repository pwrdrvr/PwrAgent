import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  ThreadQuestionnaireActivity,
} from "@pwragent/shared";

export const QUESTIONNAIRE_ACTIVITY_ENTRY_PREFIX = "questionnaire:";

export function buildQuestionnaireActivityEntries(
  activities: ThreadQuestionnaireActivity[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!activities || activities.length === 0) {
    return [];
  }
  return activities.map((activity) => {
    const completed =
      activity.status === "submitted" || activity.status === "cancelled";
    return {
      type: "activity",
      id: `${QUESTIONNAIRE_ACTIVITY_ENTRY_PREFIX}${activity.requestId}`,
      summary: summarizeQuestionnaireActivity(activity),
      createdAt: activity.updatedAt || activity.createdAt,
      status: completed ? "completed" : "in_progress",
      turn: activity.turnId
        ? {
            id: activity.turnId,
            status: completed ? "completed" : "in_progress",
            completedAt: completed ? activity.updatedAt : undefined,
          }
        : undefined,
      details: [
        {
          id: `${QUESTIONNAIRE_ACTIVITY_ENTRY_PREFIX}${activity.requestId}:details`,
          kind: "read",
          label:
            activity.status === "cancelled"
              ? "Questionnaire cancelled"
              : activity.status === "submitted"
                ? "Submitted answers"
                : "Questionnaire requested",
          markdown: buildQuestionnaireMarkdown(activity),
          status: completed ? "completed" : "in_progress",
        },
      ],
    };
  });
}

export function injectQuestionnaireActivities(
  entries: AppServerThreadEntry[],
  activities: ThreadQuestionnaireActivity[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildQuestionnaireActivityEntries(activities);
  if (synthetic.length === 0) {
    return entries;
  }
  const existingIds = new Set(entries.map((entry) => entry.id));
  const additions = synthetic.filter((entry) => !existingIds.has(entry.id));
  if (additions.length === 0) {
    return entries;
  }
  const merged: AppServerThreadEntry[] = [...entries, ...additions];
  merged.sort((left, right) => {
    const leftAt = left.createdAt ?? 0;
    const rightAt = right.createdAt ?? 0;
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    const leftIsQuestionnaire = left.id.startsWith(
      QUESTIONNAIRE_ACTIVITY_ENTRY_PREFIX,
    );
    const rightIsQuestionnaire = right.id.startsWith(
      QUESTIONNAIRE_ACTIVITY_ENTRY_PREFIX,
    );
    if (leftIsQuestionnaire === rightIsQuestionnaire) {
      return 0;
    }
    return leftIsQuestionnaire ? 1 : -1;
  });
  return merged;
}

function summarizeQuestionnaireActivity(
  activity: ThreadQuestionnaireActivity,
): string {
  if (activity.status === "cancelled") {
    return "Questionnaire cancelled";
  }
  if (activity.status === "submitted") {
    return "Questionnaire answered";
  }
  const count = activity.questions.length;
  return `Asked ${count} ${count === 1 ? "question" : "questions"}`;
}

function buildQuestionnaireMarkdown(activity: ThreadQuestionnaireActivity): string {
  const blocks = activity.questions.map((question, index) => {
    const prompt = [
      `${index + 1}. ${question.header}: ${question.question}`,
      formatAnswerLine(activity, question.id),
    ].filter(Boolean);
    if (activity.status === "pending" && question.options?.length) {
      prompt.push(
        ...question.options.map((option) =>
          option.description
            ? `- ${option.label}: ${option.description}`
            : `- ${option.label}`,
        ),
      );
    }
    return prompt.join("\n");
  });
  return blocks.join("\n\n");
}

function formatAnswerLine(
  activity: ThreadQuestionnaireActivity,
  questionId: string,
): string | undefined {
  if (activity.status === "pending") {
    return undefined;
  }
  const answers = activity.answers?.[questionId]?.answers ?? [];
  if (answers.length === 0) {
    return activity.status === "cancelled" ? "Answer: Cancelled" : "Answer: None";
  }
  return `Answer: ${answers.join(", ")}`;
}
