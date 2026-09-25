import type {
  AppServerReviewTarget,
  AppServerToolRequestUserInputNotification,
  CodexAsyncQuestion,
  NavigationSnapshot,
} from "@pwragent/shared";
import { coalesceToolActivityBurst } from "@pwragent/shared";
import type {
  MessagingActivityIntent,
  MessagingConfirmationIntent,
  MessagingErrorIntent,
  MessagingQuestionnaireIntent,
  MessagingStatusIntent,
  MessagingSurfaceAction,
  MessagingMessageIntent,
  MessagingReviewStartNotification,
  MessagingReviewStartTarget,
  MessagingThreadPickerIntent,
  MessagingWorkingCardIntent,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  truncateMessagingLabel,
  type MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";
import {
  formatToolActivityDuration,
  formatToolActivityLine,
  type MessagingToolActivity,
} from "./messaging-tool-activity.js";
export { buildApprovalIntent } from "./messaging-approval-renderer.js";

export function buildActivityIntent(params: {
  activity: MessagingActivityIntent["activity"];
  bindingId?: string;
  createdAt: number;
  id: string;
  leaseMs?: number;
  sessionState?: MessagingActivityIntent["sessionState"];
  state: MessagingActivityIntent["state"];
}): MessagingActivityIntent {
  return {
    id: params.id,
    kind: "activity",
    activity: params.activity,
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    leaseMs: params.leaseMs,
    sessionState: params.sessionState,
    state: params.state,
  };
}

export function buildThreadPickerIntent(params: {
  actions: MessagingSurfaceAction[];
  createdAt: number;
  fallbackText: string;
  id: string;
  navigation: NavigationSnapshot;
  pageSize: number;
  prompt?: string;
}): MessagingThreadPickerIntent {
  return {
    id: params.id,
    kind: "thread_picker",
    createdAt: params.createdAt,
    fallbackText: params.fallbackText,
    navigation: {
      backend: params.navigation.backend,
      fetchedAt: params.navigation.fetchedAt,
      unchanged: params.navigation.unchanged,
    },
    page: {
      actions: params.actions,
      items: params.navigation.threads.slice(0, params.pageSize),
      pageIndex: 0,
      pageSize: params.pageSize,
      totalItems: params.navigation.threads.length,
    },
    prompt: params.prompt ?? params.fallbackText,
  };
}

export function buildStatusIntent(params: {
  createdAt: number;
  id: string;
  status: MessagingStatusIntent["status"];
  text: string;
}): MessagingStatusIntent {
  return {
    id: params.id,
    kind: "status",
    createdAt: params.createdAt,
    status: params.status,
    text: params.text,
  };
}

export function buildToolUpdateMessageIntent(params: {
  activity: MessagingToolActivity;
  bindingId: string;
  createdAt: number;
  id: string;
}): MessagingMessageIntent {
  if (params.activity.kind === "prose") {
    return {
      id: params.id,
      kind: "message",
      bindingId: params.bindingId,
      createdAt: params.createdAt,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: params.activity.title,
          markdown: "markdown",
        },
      ],
    };
  }
  return {
    id: params.id,
    kind: "message",
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    role: "system",
    parts: [
      {
        type: "text",
        text: `Tool update: ${formatToolActivityLine(params.activity)}`,
        markdown: "light",
      },
    ],
  };
}

export function buildToolUpdateBatchMessageIntent(params: {
  activities: MessagingToolActivity[];
  bindingId: string;
  createdAt: number;
  id: string;
}): MessagingMessageIntent {
  // A coalesced batch can blend the agent's in-turn prose with tool activity.
  // Render the prose blocks verbatim (they are assistant markdown) and summarize
  // the tool activity under its own header so prose is never mislabeled as a
  // "ran N tools" line. Tool-only batches keep the original header/format so
  // existing tool-update behavior is unchanged.
  const proseActivities = params.activities.filter(
    (activity) => activity.kind === "prose",
  );
  const toolActivities = params.activities.filter(
    (activity) => activity.kind !== "prose",
  );
  const segments: string[] = proseActivities.map((activity) => activity.title);
  if (toolActivities.length > 0) {
    const count = toolActivities.length;
    const groupedActivities = coalesceToolActivityBurst(
      toolActivities.map((activity) => ({
        activity,
        label: formatToolActivityLine(activity),
        status: activity.status,
      })),
    );
    const visibleGroups = groupedActivities.slice(0, 5);
    const omittedToolCount = groupedActivities
      .slice(5)
      .reduce((total, group) => total + group.count, 0);
    segments.push(
      [
        `Tool updates: ran ${count} tool${count === 1 ? "" : "s"}`,
        ...visibleGroups.map((group) =>
          `- ${group.count === 1 ? group.label : `${group.count} × ${group.label}`}`
        ),
        ...(omittedToolCount > 0
          ? [`- ${omittedToolCount} other tool update${omittedToolCount === 1 ? "" : "s"}`]
          : []),
      ].join("\n"),
    );
  }
  const hasProse = proseActivities.length > 0;
  return {
    id: params.id,
    kind: "message",
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    role: hasProse ? "assistant" : "system",
    parts: [
      {
        type: "text",
        text: segments.join("\n\n"),
        markdown: hasProse ? "markdown" : "light",
      },
    ],
  };
}

export function buildWorkingCardIntent(params: {
  activities: MessagingToolActivity[];
  bindingId: string;
  createdAt: number;
  displayHint: MessagingWorkingCardIntent["card"]["displayHint"];
  fallbackActivities?: MessagingToolActivity[];
  id: string;
  key: string;
  omittedTaskCount?: number;
  sequence: number;
}): MessagingWorkingCardIntent {
  const fallback = buildToolUpdateBatchMessageIntent({
    activities: params.fallbackActivities ?? params.activities,
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    id: `${params.id}:fallback`,
  });
  const fallbackPart = fallback.parts[0];
  const tasks = params.activities.map((activity) => {
    const detail = workingCardTaskDetail(activity);
    return {
      id: activity.id,
      status: activity.status === "failed"
        ? "error" as const
        : activity.status === "cancelled"
          ? "cancelled" as const
          : "complete" as const,
      title: activity.title,
      ...(detail ? { detail } : {}),
    };
  });
  if (params.omittedTaskCount && params.omittedTaskCount > 0 && tasks[0]) {
    tasks[0] = {
      ...tasks[0],
      detail: [
        `${params.omittedTaskCount} earlier step${
          params.omittedTaskCount === 1 ? "" : "s"
        }`,
        tasks[0].detail,
      ].filter(Boolean).join(" · "),
    };
  }
  return {
    id: params.id,
    kind: "working_card",
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    fallbackText: fallbackPart?.type === "text"
      ? fallbackPart.text
      : "Working update",
    card: {
      displayHint: params.displayHint,
      fallbackPresentation: {
        markdown: fallbackPart?.type === "text"
          ? fallbackPart.markdown ?? "light"
          : "light",
        role: fallback.role === "assistant" ? "assistant" : "system",
      },
      isFinal: false,
      key: params.key,
      phase: "working",
      sequence: params.sequence,
      tasks,
    },
  };
}

function workingCardTaskDetail(
  activity: MessagingToolActivity,
): string | undefined {
  return [
    activity.status === "cancelled" ? "Cancelled" : undefined,
    activity.durationMs !== undefined
      ? formatToolActivityDuration(activity.durationMs)
      : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

export function buildConfirmationIntent(params: {
  actions?: MessagingSurfaceAction[];
  body: string;
  browseSessionId?: MessagingConfirmationIntent["browseSessionId"];
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  delivery?: MessagingConfirmationIntent["delivery"];
  fallbackText?: string;
  id: string;
  reviewStart?: MessagingConfirmationIntent["reviewStart"];
  targetSurface?: MessagingConfirmationIntent["targetSurface"];
  title: string;
}): MessagingConfirmationIntent {
  return {
    id: params.id,
    kind: "confirmation",
    actions: applyActionCapabilityLimits(params.actions ?? [], params.capabilityProfile),
    body: params.body,
    browseSessionId: params.browseSessionId,
    createdAt: params.createdAt,
    delivery: params.delivery,
    fallbackText: params.fallbackText,
    ...(params.reviewStart ? { reviewStart: params.reviewStart } : {}),
    targetSurface: params.targetSurface,
    title: params.title,
  };
}

/**
 * Build the generic confirmation delivered by every messaging adapter when a
 * review is accepted. Keep the structured contract and its visible text
 * together so fallback-only transports cannot lose reviewer context.
 */
export function buildReviewStartConfirmationIntent(params: {
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  delivery?: MessagingConfirmationIntent["delivery"];
  id: string;
  notification: MessagingReviewStartNotification;
  targetSurface?: MessagingConfirmationIntent["targetSurface"];
}): MessagingConfirmationIntent {
  const title = params.notification.status === "scheduled"
    ? "Review queued"
    : "Review started";
  const body = formatReviewStartNotification(params.notification);
  return buildConfirmationIntent({
    id: params.id,
    capabilityProfile: params.capabilityProfile,
    createdAt: params.createdAt,
    title,
    body,
    fallbackText: [title, body].join("\n\n"),
    reviewStart: params.notification,
    ...(params.targetSurface
      ? {
          targetSurface: params.targetSurface,
          delivery: params.delivery,
        }
      : {}),
  });
}

export function formatReviewStartNotification(
  notification: MessagingReviewStartNotification,
): string {
  const reviewer = notification.reviewer;
  return [
    notification.status === "scheduled"
      ? `${formatReviewStartTarget(notification.target)} will start after the active turn completes successfully.`
      : `${formatReviewStartTarget(notification.target)} is now running.`,
    "",
    `Reviewer: ${formatReviewerLabel(reviewer)}`,
    ...(reviewer.model ? [`Model: ${reviewer.model}`] : []),
    ...(reviewer.reasoningEffort
      ? [`Reasoning: ${reviewer.reasoningEffort}`]
      : []),
  ].join("\n");
}

export function messagingReviewStartTarget(
  target: AppServerReviewTarget,
): MessagingReviewStartTarget {
  switch (target.type) {
    case "pullRequest":
      return { type: "pullRequest", url: target.url, headCommit: target.snapshot?.headCommit };
    case "uncommittedChanges":
      return { type: "uncommittedChanges" };
    case "baseBranch":
      return { type: "baseBranch", branch: target.branch };
    case "commit":
      return { type: "commit", sha: target.sha };
    case "custom":
      return { type: "custom" };
  }
}

function formatReviewStartTarget(target: MessagingReviewStartTarget): string {
  switch (target.type) {
    case "pullRequest":
      return `Review ${target.url}${target.headCommit ? ` at ${target.headCommit.slice(0, 10)}` : ""}`;
    case "uncommittedChanges":
      return "Current changes review";
    case "baseBranch":
      return `Review against ${target.branch}`;
    case "commit":
      return `Review of commit ${target.sha}`;
    case "custom":
      return "Custom review";
  }
}

function formatReviewerLabel(
  reviewer: MessagingReviewStartNotification["reviewer"],
): string {
  const label = reviewer.label?.trim();
  const backend = reviewer.backend;
  return label && label !== backend ? `${label} (${backend})` : backend;
}

export function buildErrorIntent(params: {
  body: string;
  createdAt: number;
  id: string;
  recoverable?: boolean;
  title: string;
}): MessagingErrorIntent {
  return {
    id: params.id,
    kind: "error",
    body: params.body,
    createdAt: params.createdAt,
    recoverable: params.recoverable,
    title: params.title,
  };
}

/**
 * Presents the questions a Codex `request_user_input_async` message asked.
 * Codex lets the operator pick an option or type an answer for every
 * question, a question without options takes typed text only, and the agent
 * puts its recommended option first. Question ids include the intent id so an
 * option on an older question card never matches a newer one.
 */
export function buildAsyncQuestionnaireIntent(params: {
  asyncReply: NonNullable<MessagingQuestionnaireIntent["asyncReply"]>;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  questions: readonly CodexAsyncQuestion[];
}): MessagingQuestionnaireIntent {
  const labelLimit = params.capabilityProfile?.actions?.maxLabelLength;
  return {
    id: params.id,
    kind: "questionnaire",
    createdAt: params.createdAt,
    answers: params.questions.map(() => null),
    asyncReply: params.asyncReply,
    currentIndex: 0,
    phase: "answering",
    fallbackText: "Reply with an option or your own answer, or Skip.",
    questions: params.questions.map((question, questionIndex) => {
      const questionId = `${params.id}:question:${questionIndex + 1}`;
      return {
        id: questionId,
        question: question.title,
        allowFreeform: true,
        options: (question.options ?? []).map((option, index) => ({
          id: `${questionId}:option:${index + 1}`,
          label: labelLimit === undefined ? option : truncateMessagingLabel(option, labelLimit),
          fallbackText: String(index + 1),
          recommended: index === 0,
          value: option,
        })),
      };
    }),
  };
}

export function buildQuestionnaireIntent(params: {
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  request: AppServerToolRequestUserInputNotification;
}): MessagingQuestionnaireIntent {
  const labelLimit = params.capabilityProfile?.actions?.maxLabelLength;
  return {
    id: params.id,
    kind: "questionnaire",
    createdAt: params.createdAt,
    answers: params.request.params.questions.map(() => null),
    currentIndex: 0,
    phase: "answering",
    fallbackText: "Reply with an option, Back, Next, Submit, or a free-form answer.",
    questions: params.request.params.questions.map((question) => ({
      id: question.id,
      header: question.header || undefined,
      question: question.question || question.header,
      allowFreeform: question.isOther,
      secret: question.isSecret,
      options: (question.options ?? []).map((option, index) => ({
        id: `${question.id}:option:${index + 1}`,
        label: labelLimit === undefined ? option.label : truncateMessagingLabel(option.label, labelLimit),
        description: option.description || undefined,
        fallbackText: String(index + 1),
        recommended: /\(recommended\)/i.test(option.label),
        value: option.label,
      })),
    })),
  };
}
