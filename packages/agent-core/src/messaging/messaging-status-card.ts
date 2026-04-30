import type {
  MessagingBindingRecord,
  MessagingStatusIntent,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragnt/shared";

export function buildBindingStatusIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  navigation?: NavigationSnapshot;
}): MessagingStatusIntent {
  const thread = findThread(params.navigation, params.binding);
  const display = params.binding.threadDisplay;
  const preferences = params.binding.preferences;
  const defaults = params.navigation?.launchpadDefaults;
  const projectLabel =
    display?.projectLabel ?? thread?.linkedDirectories[0]?.label ?? unavailable();
  const directoryPath =
    display?.directoryPath ?? thread?.linkedDirectories[0]?.path ?? unavailable();
  const model = preferences?.model ?? thread?.model ?? defaults?.model ?? unavailable();
  const reasoning =
    preferences?.reasoningEffort ??
    thread?.reasoningEffort ??
    defaults?.reasoningEffort ??
    unavailable();
  const fastMode = preferences?.fastMode ?? defaults?.fastMode;
  const permissionsMode =
    preferences?.permissionsMode ??
    (preferences?.executionMode === "full-access" ? "full-access" : undefined) ??
    (defaults?.executionMode === "full-access" ? "full-access" : "default");
  const activeTurn = params.binding.activeTurn;

  return {
    id: params.id,
    kind: "status",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
      pin: true,
    },
    targetSurface: params.binding.statusSurface,
    status: statusForBinding(params.binding),
    text: [
      `Binding: ${display?.threadTitle ?? thread?.title ?? params.binding.threadId} (${params.binding.backend})`,
      `Project: ${projectLabel}`,
      `Directory: ${directoryPath}`,
      display?.worktreePath ? `Worktree: ${display.worktreePath}` : undefined,
      `Model: ${model}`,
      `Reasoning: ${reasoning}`,
      `Fast mode: ${fastMode === undefined ? unavailable() : fastMode ? "on" : "off"}`,
      "Plan mode: unavailable",
      `Permissions: ${permissionsMode === "full-access" ? "Full Access" : "Default Access"}`,
      "Context usage: unavailable",
      "Account: unavailable",
      "Rate limits: unavailable",
      `Thread: ${params.binding.threadId}`,
      activeTurn ? `Turn: ${activeTurn.status} (${activeTurn.turnId})` : "Turn: idle",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    actions: [
      {
        id: "status:model",
        label: "Model",
        style: "secondary",
        fallbackText: "model",
      },
      {
        id: "status:reasoning",
        label: `Reasoning: ${reasoning}`,
        style: "secondary",
        fallbackText: "reasoning",
      },
      {
        id: "status:fast",
        label: fastMode ? "Fast: on" : "Fast: off",
        style: "secondary",
        fallbackText: "fast",
      },
      {
        id: "status:permissions",
        label:
          permissionsMode === "full-access"
            ? "Permissions: Full Access"
            : "Permissions: Default",
        style: "secondary",
        fallbackText: "permissions",
      },
      {
        id: "status:compact",
        label: "Compact",
        style: "secondary",
        fallbackText: "compact",
      },
      {
        id: "status:stop",
        label: "Stop",
        style: "danger",
        fallbackText: "stop",
      },
      {
        id: "status:refresh",
        label: "Refresh",
        style: "secondary",
        fallbackText: "refresh",
      },
      {
        id: "status:detach",
        label: "Detach",
        style: "danger",
        fallbackText: "detach",
      },
    ],
  };
}

function findThread(
  navigation: NavigationSnapshot | undefined,
  binding: MessagingBindingRecord,
): NavigationThreadSummary | undefined {
  return navigation?.threads.find(
    (thread) => thread.source === binding.backend && thread.id === binding.threadId,
  );
}

function statusForBinding(
  binding: MessagingBindingRecord,
): MessagingStatusIntent["status"] {
  switch (binding.activeTurn?.status) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
    case "interrupted":
      return "failed";
    case "completed":
    case undefined:
      return "idle";
  }
}

function unavailable(): string {
  return "unavailable";
}
