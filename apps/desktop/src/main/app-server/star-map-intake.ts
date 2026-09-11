import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  NavigationDirectoryRow,
  StarMapIntakeCandidate,
  StarMapIntakeCandidateSource,
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
/**
 * Create without asking at or above this much confidence in the leading
 * project. Below it the operator picks — but from the resolver's ranking,
 * not from the registry in storage order.
 */
const AUTO_CREATE_CONFIDENCE = 0.5;
const MAX_CANDIDATE_REASON_CHARS = 120;

/**
 * The resolver ranks; it does not choose. One pick plus a confidence number
 * throws away everything it knew about the runners-up, which is exactly what
 * the operator needs when the pick is not confident enough to act on.
 *
 * No title field: `materializeDirectoryLaunchpad` schedules thread-title
 * generation from this same first turn, so asking for one here bought a
 * second title that nothing ever read.
 */
const INTAKE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          directoryKey: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["directoryKey", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

type RankedDirectory = {
  directory: NavigationDirectoryRow;
  confidence: number;
  reason?: string;
};

function publishIntakeStatus(params: {
  requestId: string;
  phase: StarMapIntakePhase;
  message?: string;
  backend?: string;
  threadId?: string;
  /**
   * The project the intake resolved to, sent with `creating`. This is the
   * only moment the operator can still catch a wrong pick — after this the
   * thread exists — and in the confident path nothing else ever names it.
   */
  directoryLabel?: string;
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
  // The branch an operator is sitting on is often the only thing their
  // request names ("finish the icon work"), and it costs one short field.
  if (directory.gitStatus?.currentBranch) {
    parts.push(`branch=${directory.gitStatus.currentBranch}`);
  }
  return parts.join(" | ");
}

/** Most-recently-active first; never-used directories sort last. */
function byRecency(
  left: NavigationDirectoryRow,
  right: NavigationDirectoryRow,
): number {
  return (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
}

async function resolveViaConfiguredBackend(params: {
  text: string;
  preferences?: string;
  directories: NavigationDirectoryRow[];
}): Promise<RankedDirectory[] | undefined> {
  const byKey = new Map(
    params.directories.map((directory) => [directory.key, directory]),
  );
  try {
    const result = await getDesktopBackendRegistry().generateStructuredObject({
      timeoutMs: INTAKE_TIMEOUT_MS,
      schema: INTAKE_SCHEMA,
      schemaName: "star_map_intake_resolution",
      system: [
        "You rank the operator's registered project directories against a",
        "natural-language task request.",
        "Return the plausible directories, most likely first, at most",
        `${MAX_DISAMBIGUATION_CANDIDATES}. Use directoryKey values from the`,
        "provided list only.",
        "confidence is 0..1 that the task belongs to that directory.",
        "reason is one short clause (under 12 words) naming the evidence",
        "you used, addressed to the operator: \"matches the PwrSnap",
        "screenshot work\", not \"the request mentions screenshots\".",
        "When nothing in the request points anywhere, return an empty",
        "array rather than guessing: the operator is then asked to pick,",
        "and an invented ranking makes that harder, not easier.",
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
    const object = result.object as { candidates?: unknown };
    if (!Array.isArray(object.candidates)) return [];
    const seen = new Set<string>();
    const ranked: RankedDirectory[] = [];
    for (const entry of object.candidates) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as {
        directoryKey?: unknown;
        confidence?: unknown;
        reason?: unknown;
      };
      if (typeof record.directoryKey !== "string") continue;
      const directory = byKey.get(record.directoryKey);
      if (!directory || seen.has(directory.key)) continue;
      seen.add(directory.key);
      const reason =
        typeof record.reason === "string" ? record.reason.trim() : "";
      ranked.push({
        directory,
        confidence:
          typeof record.confidence === "number"
          && Number.isFinite(record.confidence)
            ? record.confidence
            : 0,
        reason: reason
          ? reason.slice(0, MAX_CANDIDATE_REASON_CHARS)
          : undefined,
      });
    }
    return ranked.slice(0, MAX_DISAMBIGUATION_CANDIDATES);
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

function candidateOf(entry: RankedDirectory): StarMapIntakeCandidate {
  return {
    directoryKey: entry.directory.key,
    label: entry.directory.label,
    path: entry.directory.path,
    ...(entry.reason ? { reason: entry.reason } : {}),
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
 * to a project (structured call over the directory registry + AGENTS.md
 * preferences, deterministic label match as fallback), then materialize the
 * directory's launchpad with the request as the first turn. Runs on the
 * instance that owns the [+] card.
 *
 * The resolver ranks rather than picks, and the ranking survives a low
 * score: below `AUTO_CREATE_CONFIDENCE` the operator chooses, but from the
 * resolver's order with its reasons attached. The previous shape discarded
 * the whole resolution below the threshold and fell through to a substring
 * match on directory labels — so a request that never typed a project name
 * produced the entire registry in storage order, which reads as the intake
 * having thought about nothing.
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
      const leading = resolved?.[0];
      if (leading && leading.confidence >= AUTO_CREATE_CONFIDENCE) {
        directoryKey = leading.directory.key;
      } else {
        const fuzzy = fuzzyMatchDirectories(text, directories);
        if (fuzzy.length === 1) {
          directoryKey = fuzzy[0].key;
        } else {
          // Prefer the resolver's ranking; then the label match; then the
          // registry by recency. Recency is the last of those because it
          // answers a different question than the request did — but "what
          // you were working in" beats whatever order storage returned.
          //
          // The source travels with the list because the dialog's copy has
          // to match it: "closest match first" over a recency fallback
          // claims a judgment nobody made.
          let candidateSource: StarMapIntakeCandidateSource;
          let ranked: RankedDirectory[];
          if (resolved && resolved.length > 0) {
            candidateSource = "resolver";
            ranked = resolved;
          } else {
            candidateSource = fuzzy.length > 0 ? "label" : "recent";
            ranked = (
              fuzzy.length > 0 ? fuzzy : [...directories].sort(byRecency)
            ).map((directory) => ({ directory, confidence: 0 }));
          }
          publishIntakeStatus({ requestId, phase: "needs_disambiguation" });
          return {
            status: "needs_disambiguation",
            requestId,
            candidateSource,
            candidates: ranked
              .slice(0, MAX_DISAMBIGUATION_CANDIDATES)
              .map(candidateOf),
          };
        }
      }
    }

    const directory = directories.find((entry) => entry.key === directoryKey);
    if (!directory) {
      throw new Error(`Directory is no longer available: ${directoryKey}`);
    }
    publishIntakeStatus({
      requestId,
      phase: "creating",
      directoryLabel: directory.label,
    });
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("star map intake failed", { error: message });
    publishIntakeStatus({ requestId, phase: "failed", message });
    return { status: "failed", requestId, error: message };
  }
}
