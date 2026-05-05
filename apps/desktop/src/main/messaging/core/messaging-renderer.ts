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
  const count = params.activities.length;
  return {
    id: params.id,
    kind: "message",
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    role: "system",
    parts: [
      {
        type: "text",
        text: [
          `Tool updates: ran ${count} tool${count === 1 ? "" : "s"}`,
          ...params.activities.map((activity) => `- ${formatToolActivityLine(activity)}`),
        ].join("\n"),
        markdown: "light",
      },
    ],
  };
}

export function buildConfirmationIntent(params: {
  actions?: MessagingSurfaceAction[];
  body: string;
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
    currentIndex: 0,
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
      })),
    })),
  };
}
