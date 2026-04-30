import type {
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  MessagingApprovalIntent,
  MessagingConfirmationIntent,
  MessagingErrorIntent,
  MessagingQuestionnaireIntent,
  MessagingStatusIntent,
  MessagingSurfaceAction,
  MessagingThreadPickerIntent,
  NavigationSnapshot,
} from "@pwragnt/shared";

export function buildThreadPickerIntent(params: {
  actions: MessagingSurfaceAction[];
  createdAt: number;
  fallbackText: string;
  id: string;
  navigation: NavigationSnapshot;
  pageSize: number;
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

export function buildConfirmationIntent(params: {
  actions?: MessagingSurfaceAction[];
  body: string;
  createdAt: number;
  fallbackText?: string;
  id: string;
  title: string;
}): MessagingConfirmationIntent {
  return {
    id: params.id,
    kind: "confirmation",
    actions: params.actions ?? [],
    body: params.body,
    createdAt: params.createdAt,
    fallbackText: params.fallbackText,
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
  createdAt: number;
  id: string;
  request: AppServerToolRequestUserInputNotification;
}): MessagingQuestionnaireIntent {
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
        label: option.label,
        description: option.description || undefined,
        fallbackText: String(index + 1),
        recommended: /\(recommended\)/i.test(option.label),
      })),
    })),
  };
}

export function buildApprovalIntent(params: {
  createdAt: number;
  id: string;
  request: AppServerPendingRequestNotification;
}): MessagingApprovalIntent {
  const prompt = typeof params.request.params.prompt === "string"
    ? params.request.params.prompt
    : "Approve this action?";

  return {
    id: params.id,
    kind: "approval",
    createdAt: params.createdAt,
    title: "Approval needed",
    body: prompt,
    fallbackText: "Reply yes, yes for this session, no, or cancel.",
    decisions: [
      {
        id: "approval:accept",
        label: "Allow",
        decision: "accept",
        style: "primary",
        fallbackText: "yes",
      },
      {
        id: "approval:accept_for_session",
        label: "Allow for session",
        decision: "accept_for_session",
        style: "secondary",
        fallbackText: "yes for this session",
      },
      {
        id: "approval:decline",
        label: "Decline",
        decision: "decline",
        style: "danger",
        fallbackText: "no",
      },
      {
        id: "approval:cancel",
        label: "Cancel",
        decision: "cancel",
        style: "secondary",
        fallbackText: "cancel",
      },
    ],
  };
}
