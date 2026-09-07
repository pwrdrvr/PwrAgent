import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  NavigationDirectoryRow,
  StarMapIntakeCandidate,
  StarMapIntakePhase,
  StarMapIntakeRequest,
  StarMapIntakeResponse,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { resolveActiveProfileDir, resolvePwragentRoot } from "../profile";
import { readLocalNavigationDirectoryIndex } from "./navigation-directory-index";
import {
  getDesktopBackendRegistry,
  type DesktopBackendRegistry,
} from "./backend-registry";

const log = getMainLogger("pwragent:star-map-intake");

const INTAKE_TIMEOUT_MS = 20_000;
const INTAKE_PREFERENCES_MAX_CHARS = 8_000;
const MAX_DISAMBIGUATION_CANDIDATES = 8;

const INTAKE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    directoryKey: { type: ["string", "null"] },
    confidence: { type: "number" },
    notes: { type: ["string", "null"] },
  },
  required: ["title", "directoryKey", "confidence"],
  additionalProperties: false,
};

type IntakeResolution = {
  title?: string;
  directoryKey?: string;
  confidence: number;
};

function publishIntakeStatus(params: {
  requestId: string;
  phase: StarMapIntakePhase;
  message?: string;
  backend?: string;
  threadId?: string;
}): void {
  // publishLocalEvent fans out to this instance's windows AND to remote
  // viewers over the federation backend-event channel, so the requesting
  // dialog streams progress no matter which machine it runs on.
  void getDesktopBackendRegistry()
    .publishLocalEvent({
      backend: "codex",
      notification: {
        method: "starMap/intake/status",
        params,
      },
    })
    .catch(() => {
      // Progress is best-effort; the RPC response carries the outcome.
    });
}

/**
 * Operator thread-startup preferences: profile-scoped AGENTS.md first
 * (~/.pwragent/profiles/<p>/AGENTS.md), then the root ~/.pwragent/AGENTS.md.
 */
async function readIntakePreferences(): Promise<string | undefined> {
  const candidates = [
    path.join(resolveActiveProfileDir(), "AGENTS.md"),
    path.join(resolvePwragentRoot(), "AGENTS.md"),
  ];
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      if (text.trim().length > 0) {
        return text.slice(0, INTAKE_PREFERENCES_MAX_CHARS);
      }
    } catch {
      // Missing file — preferences are optional.
    }
  }
  return undefined;
}

function describeDirectory(directory: NavigationDirectoryRow): string {
  const parts = [
    `key=${directory.key}`,
    `label=${directory.label}`,
  ];
  if (directory.path) parts.push(`path=${directory.path}`);
  parts.push(`threads=${directory.counts.total}`);
  return parts.join(" | ");
}

async function resolveViaConfiguredBackend(params: {
  text: string;
  preferences?: string;
  directories: NavigationDirectoryRow[];
}): Promise<IntakeResolution | undefined> {
  try {
    const result = await getDesktopBackendRegistry().generateStructuredObject({
      timeoutMs: INTAKE_TIMEOUT_MS,
      schema: INTAKE_SCHEMA,
      schemaName: "star_map_intake_resolution",
      system: [
        "You resolve a natural-language task request to one of the",
        "operator's registered project directories and give the task a",
        "short thread title.",
        "Pick directoryKey ONLY from the provided list; null when no",
        "directory clearly matches.",
        "confidence is 0..1 for the directory pick.",
        "Return JSON matching the schema exactly.",
      ].join("\n"),
      prompt: [
        params.preferences
          ? `Operator thread-startup preferences (AGENTS.md):\n${params.preferences}\n`
          : "",
        "Registered project directories:",
        ...params.directories.map((directory) => `- ${describeDirectory(directory)}`),
        "",
        `Task request: ${params.text}`,
      ].join("\n"),
    });
    if (result.status !== "ok") {
      throw new Error(result.reason);
    }
    const object = result.object as {
      title?: unknown;
      directoryKey?: unknown;
      confidence?: unknown;
    };
    const directoryKey =
      typeof object.directoryKey === "string"
      && params.directories.some((directory) => directory.key === object.directoryKey)
        ? object.directoryKey
        : undefined;
    return {
      title: typeof object.title === "string" ? object.title.trim() : undefined,
      directoryKey,
      confidence:
        typeof object.confidence === "number" && Number.isFinite(object.confidence)
          ? object.confidence
          : 0,
    };
  } catch (error) {
    log.warn("star map intake structured resolution unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Deterministic fallback: rank directories by label-token hits. */
function fuzzyMatchDirectories(
  text: string,
  directories: NavigationDirectoryRow[],
): NavigationDirectoryRow[] {
  const haystack = text.toLowerCase();
  return directories
    .map((directory) => {
      const label = directory.label.toLowerCase();
      const score = haystack.includes(label)
        ? label.length
        : 0;
      return { directory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.directory);
}

function candidateOf(
  directory: NavigationDirectoryRow,
): StarMapIntakeCandidate {
  return {
    directoryKey: directory.key,
    label: directory.label,
    path: directory.path,
  };
}

export async function ensureStarMapIntakeLaunchpad(
  registry: Pick<DesktopBackendRegistry, "ensureDirectoryLaunchpad">,
  directory: NavigationDirectoryRow,
) {
  return (await registry.ensureDirectoryLaunchpad({
    directoryKey: directory.key,
    directoryKind: directory.kind,
    directoryLabel: directory.label,
    directoryPath: directory.path,
    currentBranch: directory.gitStatus?.currentBranch,
    preferredBackend: directory.launchpadBackend,
  })).launchpad;
}

/**
 * The Star Map [+] intake: resolve the operator's natural-language request
 * to a project (Grok structured call over the directory registry +
 * AGENTS.md preferences, deterministic label match as fallback), then
 * materialize the directory's launchpad with the request as the first
 * turn. Runs on the instance that owns the [+] card.
 */
export async function dispatchStarMapIntake(
  request: StarMapIntakeRequest,
): Promise<StarMapIntakeResponse> {
  const requestId = request.requestId;
  const text = request.request.trim();
  if (!requestId || !text) {
    return {
      status: "failed",
      requestId,
      error: "Describe the task to start a thread.",
    };
  }
  try {
    publishIntakeStatus({ requestId, phase: "resolving" });
    const directories = (await readLocalNavigationDirectoryIndex()).filter(
      (directory) => directory.kind !== "unlinked",
    );

    let directoryKey = request.directoryKey;
    let title: string | undefined;
    if (
      directoryKey
      && !directories.some((directory) => directory.key === directoryKey)
    ) {
      directoryKey = undefined;
    }
    if (!directoryKey) {
      const preferences = await readIntakePreferences();
      const resolved = await resolveViaConfiguredBackend({
        text,
        preferences,
        directories,
      });
      if (resolved && resolved.directoryKey && resolved.confidence >= 0.5) {
        directoryKey = resolved.directoryKey;
        title = resolved.title;
      } else {
        const fuzzy = fuzzyMatchDirectories(text, directories);
        if (fuzzy.length === 1) {
          directoryKey = fuzzy[0].key;
          title = resolved?.title;
        } else {
          const ranked = fuzzy.length > 0 ? fuzzy : directories;
          publishIntakeStatus({ requestId, phase: "needs_disambiguation" });
          return {
            status: "needs_disambiguation",
            requestId,
            candidates: ranked
              .slice(0, MAX_DISAMBIGUATION_CANDIDATES)
              .map(candidateOf),
          };
        }
      }
    }

    publishIntakeStatus({ requestId, phase: "creating" });
    const directory = directories.find((entry) => entry.key === directoryKey);
    if (!directory) {
      throw new Error(`Directory is no longer available: ${directoryKey}`);
    }
    const registry = getDesktopBackendRegistry();
    const launchpad = await ensureStarMapIntakeLaunchpad(registry, directory);
    const materialized = await registry.materializeDirectoryLaunchpad(
      {
        directoryKey,
        launchpad,
        input: [
          { type: "text", text },
          ...(request.attachments ?? []),
        ],
      },
      { messageOrigin: { kind: "pwragent" } },
    );
    publishIntakeStatus({
      requestId,
      phase: "done",
      backend: materialized.backend,
      threadId: materialized.threadId,
    });
    return {
      status: "created",
      requestId,
      backend: materialized.backend,
      threadId: materialized.threadId,
      title,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("star map intake failed", { error: message });
    publishIntakeStatus({ requestId, phase: "failed", message });
    return { status: "failed", requestId, error: message };
  }
}
