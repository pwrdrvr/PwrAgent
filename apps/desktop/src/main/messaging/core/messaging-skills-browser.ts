import type {
  AppServerListSkillsResponse,
  AppServerSkillSummary,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingConfirmationIntent,
  MessagingJsonValue,
  MessagingPendingSkillSelection,
  MessagingSingleSelectIntent,
  MessagingSurfaceDeliveryPolicy,
  MessagingSurfaceRef,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  capabilityProfilePageSize,
} from "@pwragent/messaging-interface";

export const SKILLS_BROWSER_PAGE_SIZE = 8;

export type MessagingSkillBrowserEntry = AppServerSkillSummary & {
  cwd?: string;
};

export function flattenSkillEntries(
  data: AppServerListSkillsResponse["data"],
): MessagingSkillBrowserEntry[] {
  const deduped = new Map<string, MessagingSkillBrowserEntry>();
  for (const entry of data) {
    for (const skill of entry.skills) {
      const name = skill.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (deduped.has(key)) continue;
      deduped.set(key, {
        ...skill,
        name,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      });
    }
  }
  return [...deduped.values()];
}

export function filterSkillEntries(
  entries: MessagingSkillBrowserEntry[],
  query?: string,
): MessagingSkillBrowserEntry[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...entries];

  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: scoreSkillEntry(entry, normalized),
    }))
    .filter(
      (
        item,
      ): item is {
        entry: MessagingSkillBrowserEntry;
        index: number;
        score: number;
      } => item.score !== undefined,
    )
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return left.index - right.index;
    })
    .map((item) => item.entry);
}

export function buildSkillsBrowserIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  entries: MessagingSkillBrowserEntry[];
  id: string;
  pageIndex?: number;
  query?: string;
  targetSurface?: MessagingSurfaceRef;
}): MessagingSingleSelectIntent {
  const filtered = filterSkillEntries(params.entries, params.query);
  const navActionCount = filtered.length > SKILLS_BROWSER_PAGE_SIZE ? 5 : 3;
  const pageSize = params.capabilityProfile
    ? capabilityProfilePageSize(
        params.capabilityProfile,
        navActionCount,
        SKILLS_BROWSER_PAGE_SIZE,
      )
    : SKILLS_BROWSER_PAGE_SIZE;
  const effectivePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / effectivePageSize));
  const pageIndex = clampPageIndex(params.pageIndex ?? 0, totalPages);
  const pageStart = pageIndex * effectivePageSize;
  const pageEntries = filtered.slice(pageStart, pageStart + effectivePageSize);
  const choices = applyActionCapabilityLimits(
    [
      ...pageEntries.map((entry, index) => {
        const skillNumber = pageStart + index + 1;
        return {
          id: "skills:select",
          label: `${skillNumber}. $${entry.name}`,
          description: skillDescription(entry),
          fallbackText: String(skillNumber),
          style: "secondary" as const,
          priority: 1 + index,
          value: skillSelectionValue(entry),
        };
      }),
      ...(pageIndex > 0
        ? [
            {
              id: "skills:previous",
              label: "Prev",
              fallbackText: "prev",
              style: "secondary" as const,
              priority: 50,
              value: pageValue(pageIndex - 1, params.query),
            },
          ]
        : []),
      ...(pageIndex < totalPages - 1
        ? [
            {
              id: "skills:next",
              label: "Next",
              fallbackText: "next",
              style: "secondary" as const,
              priority: 51,
              value: pageValue(pageIndex + 1, params.query),
            },
          ]
        : []),
      {
        id: "skills:search",
        label: params.query ? "Search Again" : "Search",
        fallbackText: "search",
        style: "secondary" as const,
        priority: 40,
      },
      ...(params.query
        ? [
            {
              id: "status:skills",
              label: "Back",
              fallbackText: "back",
              style: "secondary" as const,
              priority: 41,
            },
          ]
        : []),
      {
        id: "skills:cancel",
        label: "Cancel",
        fallbackText: "cancel",
        style: "secondary" as const,
        priority: 42,
      },
    ],
    params.capabilityProfile,
  );

  return {
    id: params.id,
    kind: "single_select",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: skillWorkflowDelivery(params.targetSurface),
    ...(params.targetSurface ? { targetSurface: params.targetSurface } : {}),
    fallbackText: skillsBrowserFallbackText({
      filteredCount: filtered.length,
      pageEntries,
      pageIndex,
      pageStart,
      query: params.query,
      totalPages,
    }),
    prompt: skillsBrowserPrompt({
      filteredCount: filtered.length,
      pageIndex,
      query: params.query,
      totalPages,
    }),
    choices,
  };
}

export function buildSkillsSearchPromptIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  targetSurface?: MessagingSurfaceRef;
}): MessagingConfirmationIntent {
  return {
    id: params.id,
    kind: "confirmation",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: skillWorkflowDelivery(params.targetSurface),
    ...(params.targetSurface ? { targetSurface: params.targetSurface } : {}),
    title: "Search Skills",
    body: "Reply with search text. PwrAgent will search skill names, descriptions, paths, and workspaces.",
    fallbackText: "Reply with search text, Back, or Cancel.",
    actions: applyActionCapabilityLimits(
      [
        {
          id: "status:skills",
          label: "Back",
          fallbackText: "back",
          style: "secondary",
          priority: 1,
        },
        {
          id: "skills:search:cancel",
          label: "Cancel",
          fallbackText: "cancel",
          style: "secondary",
          priority: 2,
        },
      ],
      params.capabilityProfile,
    ),
  };
}

export function buildSkillSelectedIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  selection: MessagingPendingSkillSelection;
  targetSurface?: MessagingSurfaceRef;
}): MessagingConfirmationIntent {
  return {
    id: params.id,
    kind: "confirmation",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: skillWorkflowDelivery(params.targetSurface),
    ...(params.targetSurface ? { targetSurface: params.targetSurface } : {}),
    title: "Skill Selected",
    body: formatSkillSelectionHelp(params.selection),
    fallbackText: "Reply Remove to clear this skill, or send your next request.",
    actions: applyActionCapabilityLimits(
      [
        {
          id: "skills:remove",
          label: "Remove",
          fallbackText: "remove",
          style: "danger",
          priority: 1,
        },
        {
          id: "status:skills",
          label: "Back",
          fallbackText: "back",
          style: "secondary",
          priority: 2,
        },
      ],
      params.capabilityProfile,
    ),
  };
}

export function buildSkillRemovedIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  removed?: MessagingPendingSkillSelection;
  targetSurface?: MessagingSurfaceRef;
}): MessagingConfirmationIntent {
  return {
    id: params.id,
    kind: "confirmation",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: skillWorkflowDelivery(params.targetSurface),
    ...(params.targetSurface ? { targetSurface: params.targetSurface } : {}),
    title: "Skill Removed",
    body: params.removed
      ? `$${params.removed.name} will no longer be prepended to your next request.`
      : "No skill is currently selected.",
    fallbackText: "Reply Skills to choose another skill, or send your next request.",
    actions: [
      {
        id: "status:skills",
        label: "Skills",
        fallbackText: "skills",
        style: "secondary",
      },
    ],
  };
}

export function skillSelectionFromValue(
  value: MessagingJsonValue | undefined,
  selectedAt: number,
  selectedActorId?: string,
): MessagingPendingSkillSelection | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = readString(record, "name")?.trim();
  if (!name) return undefined;
  return {
    name,
    selectedAt,
    ...(selectedActorId ? { selectedActorId } : {}),
    ...optionalStringField(record, "path"),
    ...optionalStringField(record, "description"),
    ...optionalStringField(record, "shortDescription"),
    ...optionalStringField(record, "cwd"),
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
  };
}

export function skillsBrowserPageFromValue(
  value: MessagingJsonValue | undefined,
): { pageIndex: number; query?: string } {
  const record = asRecord(value);
  const pageIndex =
    typeof record?.pageIndex === "number" ? Math.trunc(record.pageIndex) : 0;
  const query = readString(record, "query")?.trim();
  return {
    pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    ...(query ? { query } : {}),
  };
}

export function isSkillsSearchIntent(
  intent: MessagingSurfaceIntent,
): boolean {
  return intent.bindingId !== undefined && intent.id.includes("skills-search");
}

export function isSkillSelectionNoticeIntent(
  intent: MessagingSurfaceIntent,
): boolean {
  return intent.bindingId !== undefined && (
    intent.id.includes("skill-selected") ||
    intent.id.includes("skill-removed")
  );
}

export function isSkillsWorkflowIntent(
  intent: MessagingSurfaceIntent,
): boolean {
  return intent.bindingId !== undefined && (
    intent.id.includes("skills-browser") ||
    isSkillsSearchIntent(intent) ||
    isSkillSelectionNoticeIntent(intent)
  );
}

export function formatSkillSelectionHelp(
  selection: MessagingPendingSkillSelection,
): string {
  const description = selection.description ?? selection.shortDescription;
  return [
    `Skill: $${selection.name}`,
    description?.trim(),
    selection.cwd ? `Workspace: ${selection.cwd}` : undefined,
    selection.path ? `Path: ${selection.path}` : undefined,
    selection.enabled === false ? "Status: disabled" : undefined,
    "This skill will be prepended to your next request.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatSkillInputPrefix(
  selection: MessagingPendingSkillSelection,
): string {
  return selection.path
    ? `Use [$${selection.name}](${selection.path})`
    : `Use $${selection.name}`;
}

function skillWorkflowDelivery(
  targetSurface?: MessagingSurfaceRef,
): MessagingSurfaceDeliveryPolicy {
  return {
    mode: targetSurface ? "update" : "present",
    replaceMarkup: Boolean(targetSurface),
    fallback: "present_new",
  };
}

function skillsBrowserPrompt(params: {
  filteredCount: number;
  pageIndex: number;
  query?: string;
  totalPages: number;
}): string {
  const header = params.query?.trim()
    ? `Skills matching "${params.query.trim()}"`
    : "Skills";
  if (params.filteredCount === 0) {
    return `${header}\nNo skills matched.`;
  }
  return [
    header,
    params.totalPages > 1
      ? `Page ${params.pageIndex + 1}/${params.totalPages}.`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function skillsBrowserFallbackText(params: {
  filteredCount: number;
  pageEntries: MessagingSkillBrowserEntry[];
  pageIndex: number;
  pageStart: number;
  query?: string;
  totalPages: number;
}): string {
  const lines = [
    params.filteredCount === 0 ? "No skills matched." : undefined,
    ...params.pageEntries.map((entry, index) => {
      const number = params.pageStart + index + 1;
      const description = skillDescription(entry);
      return `${number}. $${entry.name}${description ? ` - ${description}` : ""}`;
    }),
    params.filteredCount === 0 ? "Reply Back, Search, or Cancel." : "Reply with a number, Search, Back, Next, Prev, or Cancel.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function skillDescription(entry: MessagingSkillBrowserEntry): string | undefined {
  return entry.description?.trim() || entry.shortDescription?.trim() || undefined;
}

function scoreSkillEntry(
  entry: MessagingSkillBrowserEntry,
  normalizedQuery: string,
): number | undefined {
  const name = entry.name.toLowerCase();
  if (name.startsWith(normalizedQuery)) return 0;
  if (name.includes(normalizedQuery)) return 1;
  const haystack = [
    entry.description,
    entry.shortDescription,
    entry.path,
    entry.cwd,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalizedQuery) ? 2 : undefined;
}

function skillSelectionValue(entry: MessagingSkillBrowserEntry): MessagingJsonValue {
  return {
    name: entry.name,
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.shortDescription ? { shortDescription: entry.shortDescription } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
  };
}

function pageValue(pageIndex: number, query?: string): MessagingJsonValue {
  return {
    pageIndex,
    ...(query?.trim() ? { query: query.trim() } : {}),
  };
}

function normalizeQuery(query?: string): string {
  return query?.trim().replace(/^\$+/, "").toLowerCase() ?? "";
}

function clampPageIndex(pageIndex: number, totalPages: number): number {
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.min(Math.max(0, Math.trunc(pageIndex)), totalPages - 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: "cwd" | "description" | "path" | "shortDescription",
): Partial<MessagingPendingSkillSelection> {
  const value = readString(record, key)?.trim();
  return value ? { [key]: value } : {};
}
