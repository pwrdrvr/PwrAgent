import type {
  AppServerToolRequestUserInputNotification,
  NavigationSnapshot,
} from "@pwragent/shared";
import type {
  MessagingActivityIntent,
  MessagingConfirmationIntent,
  MessagingErrorIntent,
  MessagingQuestionnaireIntent,
  MessagingStatusIntent,
  MessagingSurfaceAction,
  MessagingMessageIntent,
  MessagingThreadPickerIntent,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  truncateMessagingLabel,
  type MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";
import {
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
  state: MessagingActivityIntent["state"];
}): MessagingActivityIntent {
  return {
    id: params.id,
    kind: "activity",
    activity: params.activity,
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    leaseMs: params.leaseMs,
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
    segments.push(
      [
        `Tool updates: ran ${count} tool${count === 1 ? "" : "s"}`,
        ...toolActivities.map((activity) => `- ${formatToolActivityLine(activity)}`),
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

export function buildConfirmationIntent(params: {
  actions?: MessagingSurfaceAction[];
  body: string;
  browseSessionId?: MessagingConfirmationIntent["browseSessionId"];
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  delivery?: MessagingConfirmationIntent["delivery"];
  fallbackText?: string;
  id: string;
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
    targetSurface: params.targetSurface,
    title: params.title,
  };
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
