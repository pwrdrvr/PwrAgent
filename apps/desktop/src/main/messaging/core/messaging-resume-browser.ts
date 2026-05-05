import type {
  AppServerBackendKind,
  MessagingBindingPreferences,
  MessagingBrowseLaunchAction,
  MessagingBrowseMode,
  MessagingBrowseSelectedProject,
  MessagingBrowseSessionRecord,
  MessagingJsonValue,
  MessagingProjectPickerIntent,
  MessagingSurfaceAction,
  MessagingThreadPickerIntent,
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadIdentifier,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import { capabilityProfilePageSize } from "@pwragent/messaging-interface";

export const RESUME_BROWSER_PAGE_SIZE = 8;
const RESUME_BROWSER_NAV_ACTION_COUNT = 5;

export function resumeBrowserPageSize(
  profile?: MessagingCapabilityProfile,
): number {
  if (!profile) {
    return RESUME_BROWSER_PAGE_SIZE;
  }
  return capabilityProfilePageSize(
    profile,
    RESUME_BROWSER_NAV_ACTION_COUNT,
    RESUME_BROWSER_PAGE_SIZE,
  );
}

export type ParsedResumeCommand = {
  mode: MessagingBrowseMode;
  launchAction: MessagingBrowseLaunchAction;
  query?: string;
  cwd?: string;
  preferences?: Omit<MessagingBindingPreferences, "updatedAt">;
  error?: string;
};

export type ResumeBrowserThreadSelection = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type ResumeBrowserProjectSelection = MessagingBrowseSelectedProject;

export function parseResumeCommandArgs(args: string[]): ParsedResumeCommand {
  const tokens = normalizeOptionDashes(args.join(" "))
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const queryTokens: string[] = [];
  let mode: MessagingBrowseMode = "recents";
  let launchAction: MessagingBrowseLaunchAction = "resume_thread";
  let cwd: string | undefined;
  const preferences: Omit<MessagingBindingPreferences, "updatedAt"> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--projects" || token === "--project" || token === "-p") {
      mode = "projects";
      launchAction = "resume_thread";
      continue;
    }
    if (token === "--new") {
      mode = "new_project";
      launchAction = "start_new_thread";
      continue;
    }
    if (token === "--fast") {
      preferences.fastMode = true;
      continue;
    }
    if (token === "--no-fast") {
      preferences.fastMode = false;
      continue;
    }
    if (token === "--yolo") {
      preferences.executionMode = "full-access";
      preferences.permissionsMode = "full-access";
      continue;
    }
    if (token === "--no-yolo") {
      preferences.executionMode = "default";
      preferences.permissionsMode = "default";
      continue;
    }
    if (token === "--model") {
      const next = tokens[index + 1]?.trim();
      if (!next) {
        return { mode, launchAction, error: "Missing model after --model." };
      }
      preferences.model = next;
      index += 1;
      continue;
    }
    if (token === "--cwd") {
      const next = tokens[index + 1]?.trim();
      if (!next) {
        return { mode, launchAction, error: "Missing path after --cwd." };
      }
      cwd = next;
      index += 1;
      continue;
    }
    queryTokens.push(token);
  }

  return {
    mode,
    launchAction,
    cwd,
    preferences: Object.keys(preferences).length > 0 ? preferences : undefined,
    query: queryTokens.join(" ").trim() || undefined,
  };
}

export function buildResumeIntent(params: {
  createdAt: number;
  id: string;
  navigation: NavigationSnapshot;
  session: MessagingBrowseSessionRecord;
}): MessagingThreadPickerIntent | MessagingProjectPickerIntent {
  if (params.session.mode === "projects" || params.session.mode === "new_project") {
    return buildProjectPickerIntent(params);
  }

  return buildThreadPickerIntent(params);
}

export function selectProjectFromValue(
  value: unknown,
): ResumeBrowserProjectSelection | undefined {
  if (!isRecord(value) || typeof value.label !== "string") {
    return undefined;
  }

  return {
    directoryKey:
      typeof value.directoryKey === "string" ? value.directoryKey : undefined,
    label: value.label,
    path: typeof value.path === "string" ? value.path : undefined,
  };
}

export function selectThreadFromValue(
  value: unknown,
): ResumeBrowserThreadSelection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    (value.backend !== "codex" && value.backend !== "grok") ||
    typeof value.threadId !== "string"
  ) {
    return undefined;
  }

  return {
    backend: value.backend,
    threadId: value.threadId,
  };
}

export function directoryForProjectSelection(
  navigation: NavigationSnapshot,
  selectedProject: MessagingBrowseSelectedProject,
): NavigationDirectorySummary | undefined {
  return navigation.directories.find((directory) =>
    selectedProject.directoryKey
      ? directory.key === selectedProject.directoryKey
      : directory.label === selectedProject.label,
  );
}

function buildThreadPickerIntent(params: {
  createdAt: number;
  id: string;
  navigation: NavigationSnapshot;
  session: MessagingBrowseSessionRecord;
}): MessagingThreadPickerIntent {
  const allThreads = threadsForSession(params.navigation, params.session);
  const page = paginate(allThreads, params.session.pageIndex, params.session.pageSize);
  const actions: MessagingSurfaceAction[] = [
    ...page.items.map((thread, index) => ({
      id: "browse:select-thread",
      label: `${page.startIndex + index + 1}. ${formatThreadLabel(thread)}`,
      style: "primary" as const,
      fallbackText: String(index + 1),
      value: {
        backend: thread.source,
        threadId: thread.id,
      },
    })),
    ...navigationActions(params.session, page.pageIndex, page.totalPages),
  ];

  return {
    id: params.id,
    kind: "thread_picker",
    bindingId: params.session.bindingId,
    browseSessionId: params.session.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.session.surface ? "update" : "present",
      fallback: "present_new",
    },
    fallbackText: threadPickerFallbackText(params.session, page),
    navigation: {
      backend: params.navigation.backend,
      fetchedAt: params.navigation.fetchedAt,
      unchanged: params.navigation.unchanged,
    },
    page: {
      actions,
      filter: params.session.query,
      items: page.items,
      pageIndex: page.pageIndex,
      pageSize: params.session.pageSize,
      totalItems: page.totalItems,
    },
    prompt: threadPickerPromptText(params.session, page.totalPages, page.totalItems),
    targetSurface: params.session.surface,
  };
}

function buildProjectPickerIntent(params: {
  createdAt: number;
  id: string;
  navigation: NavigationSnapshot;
  session: MessagingBrowseSessionRecord;
}): MessagingProjectPickerIntent {
  const allProjects = projectsForSession(params.navigation, params.session);
  const page = paginate(allProjects, params.session.pageIndex, params.session.pageSize);
  const actions: MessagingSurfaceAction[] = [
    ...page.items.map((project, index) => {
      const value: Record<string, MessagingJsonValue> = {
        directoryKey: project.key,
        label: project.label,
      };
      if (typeof project.path === "string") {
        value.path = project.path;
      }

      return {
        id: "browse:select-project",
        label: `${page.startIndex + index + 1}. ${project.label} (${project.threadKeys.length})`,
        style: "primary" as const,
        fallbackText: String(index + 1),
        value,
      };
    }),
    ...navigationActions(params.session, page.pageIndex, page.totalPages),
  ];

  return {
    id: params.id,
    kind: "project_picker",
    bindingId: params.session.bindingId,
    browseSessionId: params.session.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.session.surface ? "update" : "present",
      fallback: "present_new",
    },
    fallbackText: projectPickerFallbackText(params.session, page),
    navigation: {
      backend: params.navigation.backend,
      fetchedAt: params.navigation.fetchedAt,
      unchanged: params.navigation.unchanged,
    },
    page: {
      actions,
      filter: params.session.query,
      items: page.items,
      pageIndex: page.pageIndex,
      pageSize: params.session.pageSize,
      totalItems: page.totalItems,
    },
    prompt: projectPickerPromptText(params.session, page.totalPages, page.totalItems),
    targetSurface: params.session.surface,
  };
}

function threadsForSession(
  navigation: NavigationSnapshot,
  session: MessagingBrowseSessionRecord,
): NavigationThreadSummary[] {
  let threads = navigation.threads;
  const selectedDirectory = session.selectedProject
    ? directoryForProjectSelection(navigation, session.selectedProject)
    : undefined;
  if (selectedDirectory) {
    const threadKeys = new Set(selectedDirectory.threadKeys);
    threads = threads.filter((thread) =>
      threadKeys.has(buildThreadIdentityKey(thread.source, thread.id)),
    );
  }

  const query = session.query?.trim().toLowerCase();
  if (query) {
    threads = threads.filter((thread) =>
      [
        thread.id,
        thread.title,
        thread.summary,
        thread.projectKey,
        ...thread.linkedDirectories.flatMap((directory) => [
          directory.label,
          directory.path,
          directory.worktreePath,
        ]),
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query)),
    );
  }

  return [...threads].sort(
    (left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
  );
}

function projectsForSession(
  navigation: NavigationSnapshot,
  session: MessagingBrowseSessionRecord,
): NavigationDirectorySummary[] {
  const query = session.query?.trim().toLowerCase();
  return [...navigation.directories]
    .filter((directory) => {
      if (!query) {
        return true;
      }
      return [directory.label, directory.path, directory.key]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    })
    .sort((left, right) => {
      const updatedDelta = (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
      return updatedDelta !== 0 ? updatedDelta : left.label.localeCompare(right.label);
    });
}

function navigationActions(
  session: MessagingBrowseSessionRecord,
  pageIndex: number,
  totalPages: number,
): MessagingSurfaceAction[] {
  const actions: MessagingSurfaceAction[] = [];
  let navigationRowStarted = false;
  let footerRowStarted = false;
  const addNavigationAction = (
    action: Omit<MessagingSurfaceAction, "layout">,
  ): void => {
    actions.push({
      ...action,
      ...(navigationRowStarted ? {} : { layout: { rowBreakBefore: true } }),
    });
    navigationRowStarted = true;
  };
  const addFooterAction = (action: Omit<MessagingSurfaceAction, "layout">): void => {
    actions.push({
      ...action,
      ...(footerRowStarted ? {} : { layout: { rowBreakBefore: true } }),
    });
    footerRowStarted = true;
  };
  if (pageIndex > 0) {
    addNavigationAction({
      id: "browse:page:prev",
      label: "Previous",
      style: "navigation",
      fallbackText: "back",
    });
  }
  if (pageIndex < totalPages - 1) {
    addNavigationAction({
      id: "browse:page:next",
      label: "Next",
      style: "navigation",
      fallbackText: "next",
    });
  }
  if (session.mode !== "projects" && session.mode !== "new_project") {
    addFooterAction({
      id: "browse:mode:projects",
      label: "Projects",
      style: "navigation",
      fallbackText: "projects",
    });
  } else if (session.launchAction === "resume_thread") {
    addFooterAction({
      id: "browse:mode:recents",
      label: "Recent Threads",
      style: "navigation",
      fallbackText: "recent",
    });
  }
  if (session.launchAction !== "start_new_thread") {
    addFooterAction({
      id: "browse:mode:new",
      label: "New",
      style: "secondary",
      fallbackText: "new",
    });
  }
  addFooterAction({
    id: "browse:cancel",
    label: "Cancel",
    style: "secondary",
    fallbackText: "cancel",
  });
  return actions;
}

function threadPickerPromptText(
  session: MessagingBrowseSessionRecord,
  totalPages: number,
  totalItems: number,
): string {
  const pageLabel = `Page ${session.pageIndex + 1}/${totalPages}`;
  const scope = session.selectedProject
    ? `Showing recent PwrAgent threads for ${session.selectedProject.label}.`
    : "Showing recent PwrAgent threads.";
  return [
    `${scope} ${pageLabel}.`,
    "Choose a thread to resume. Use Projects to browse by project, New to start a thread, or Cancel to close this picker.",
    totalItems === 0 ? "No matching PwrAgent threads found." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function threadPickerFallbackText(
  session: MessagingBrowseSessionRecord,
  page: {
    items: NavigationThreadSummary[];
    pageIndex: number;
    startIndex: number;
    totalItems: number;
    totalPages: number;
  },
): string {
  const controls = [
    page.pageIndex > 0 ? "previous" : undefined,
    page.pageIndex < page.totalPages - 1 ? "next" : undefined,
    "projects",
    "new",
    "cancel",
  ].filter(Boolean);
  return [
    threadPickerPromptText(session, page.totalPages, page.totalItems),
    ...page.items.map(
      (thread, index) => `${page.startIndex + index + 1}. ${formatThreadLabel(thread)}`,
    ),
    page.totalItems > 0
      ? `Reply with a number, or reply ${formatControlList(controls)}.`
      : `Reply ${formatControlList(controls)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function projectPickerPromptText(
  session: MessagingBrowseSessionRecord,
  totalPages: number,
  totalItems: number,
): string {
  const pageLabel = `Page ${session.pageIndex + 1}/${totalPages}`;
  const opening =
    session.launchAction === "start_new_thread"
      ? "Choose a project for the new PwrAgent thread."
      : "Choose a project to filter recent PwrAgent threads.";
  return [
    `${opening} ${pageLabel}.`,
    session.launchAction === "start_new_thread"
      ? "Tap a project to start a fresh thread there."
      : "Tap a project to show only that project's threads.",
    totalItems === 0 ? "No PwrAgent projects found." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function projectPickerFallbackText(
  session: MessagingBrowseSessionRecord,
  page: {
    items: NavigationDirectorySummary[];
    pageIndex: number;
    startIndex: number;
    totalItems: number;
    totalPages: number;
  },
): string {
  const controls = [
    page.pageIndex > 0 ? "previous" : undefined,
    page.pageIndex < page.totalPages - 1 ? "next" : undefined,
    session.launchAction === "resume_thread" ? "recent" : undefined,
    "cancel",
  ].filter(Boolean);
  return [
    projectPickerPromptText(session, page.totalPages, page.totalItems),
    ...page.items.map(
      (project, index) =>
        `${page.startIndex + index + 1}. ${project.label} (${project.threadKeys.length})`,
    ),
    page.totalItems > 0
      ? `Reply with a number, or reply ${formatControlList(controls)}.`
      : `Reply ${formatControlList(controls)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatThreadLabel(thread: NavigationThreadSummary): string {
  const directory = thread.linkedDirectories.find((item) => item.kind === "worktree") ??
    thread.linkedDirectories[0];
  const suffix = directory?.label ? ` (${directory.label})` : "";
  return `${thread.title}${suffix}`;
}

function formatControlList(controls: Array<string | undefined>): string {
  const values = controls.filter((value): value is string => Boolean(value));
  if (values.length <= 1) {
    return values[0] ?? "cancel";
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function paginate<T>(
  items: T[],
  pageIndex: number,
  pageSize: number,
): {
  items: T[];
  pageIndex: number;
  startIndex: number;
  totalItems: number;
  totalPages: number;
} {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePageIndex = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const startIndex = safePageIndex * pageSize;
  return {
    items: items.slice(startIndex, startIndex + pageSize),
    pageIndex: safePageIndex,
    startIndex,
    totalItems,
    totalPages,
  };
}

function normalizeOptionDashes(text: string): string {
  return text
    .replace(/(^|\s)[\u2010-\u2015\u2212](?=\S)/g, "$1--")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
