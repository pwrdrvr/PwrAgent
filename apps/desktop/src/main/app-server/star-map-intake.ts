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

/**
 * Budget for one protocol round-trip to the app server — a config read, a
 * thread start, an MCP attestation, a turn start, and the interrupt and
 * unsubscribe that clean up after a failure. Deliberately NOT the model's
 * thinking budget: those cleanup calls run on the timeout path, so a number
 * chosen to give a hard question more thinking time would also multiply how
 * long a wedged server takes to report that it is wedged.
 */
const INTAKE_TIMEOUT_MS = 20_000;
/**
 * How long the resolver may take to answer.
 *
 * This was 20s, inherited from `DEFAULT_CODEX_THREAD_TITLE_TIMEOUT_MS` by
 * copying the constant rather than by measuring this call. The title helper
 * summarizes one message into one line. This one is handed every registered
 * directory plus up to `INTAKE_PREFERENCES_MAX_CHARS` of AGENTS.md and asked
 * to rank up to `MAX_DISAMBIGUATION_CANDIDATES` projects with a written
 * reason for each — a bigger prompt, a bigger answer, and an actual
 * judgment. On expiry the whole resolution is discarded and the operator is
 * handed a list ordered by recency, so the cost of being too short is that
 * they waited and got nothing. Err long.
 */
const INTAKE_TURN_TIMEOUT_MS = 90_000;
const INTAKE_PREFERENCES_MAX_CHARS = 8_000;
/**
 * How many directories the resolver is shown. Every registered directory
 * used to go into the prompt, so latency and token cost grew with the
 * registry forever and a large enough one crowds the request itself out of
 * the model's attention — the same unbounded-input problem
 * `INTAKE_PREFERENCES_MAX_CHARS` already solves for AGENTS.md. Most-recently
 * active first, so the ones cut are the ones the operator has not touched.
 */
const INTAKE_MAX_PROMPT_DIRECTORIES = 80;
const MAX_DISAMBIGUATION_CANDIDATES = 8;
/**
 * Create without asking at or above this much confidence in the leading
 * project. Below it the operator picks — but from the resolver's ranking,
 * not from the registry in storage order.
 */
const AUTO_CREATE_CONFIDENCE = 0.5;
const MAX_CANDIDATE_REASON_CHARS = 120;
/**
 * Cut a reason at a character boundary, so a clause ending in an emoji or
 * other non-BMP character does not leave a lone surrogate in the row.
 */
function truncateReason(reason: string): string {
  if (reason.length <= MAX_CANDIDATE_REASON_CHARS) return reason;
  return [...reason].slice(0, MAX_CANDIDATE_REASON_CHARS).join("");
}

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
  const promptDirectories = [...params.directories]
    .sort(byRecency)
    .slice(0, INTAKE_MAX_PROMPT_DIRECTORIES);
  const startedAt = Date.now();
  try {
    const result = await getDesktopBackendRegistry().generateStructuredObject({
      timeoutMs: INTAKE_TIMEOUT_MS,
      turnTimeoutMs: INTAKE_TURN_TIMEOUT_MS,
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
        ...promptDirectories.map((directory) => `- ${describeDirectory(directory)}`),
        ...(promptDirectories.length < params.directories.length
          ? [
              `(${params.directories.length - promptDirectories.length} less`
              + " recently active directories omitted.)",
            ]
          : []),
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
        reason: reason ? truncateReason(reason) : undefined,
      });
    }
    // Order by the confidence the resolver reported rather than by the
    // order it happened to emit. The prompt asks for most-likely-first, but
    // nothing enforces that, and `AUTO_CREATE_CONFIDENCE` is checked against
    // the leading entry — so a model that sorts its own array wrongly would
    // ask the operator about a project it was sure of. Array#sort is stable,
    // so equal confidences keep the resolver's order.
    ranked.sort((left, right) => right.confidence - left.confidence);
    const candidates = ranked.slice(0, MAX_DISAMBIGUATION_CANDIDATES);
    // The only record of what this call actually costs. `INTAKE_TURN_TIMEOUT_MS`
    // was last set by reasoning about prompt size, because a successful
    // resolution logged nothing and there was no number to set it from.
    log.info("star map intake resolved", {
      candidateCount: candidates.length,
      directoryCount: params.directories.length,
      promptDirectoryCount: promptDirectories.length,
      elapsedMs: Date.now() - startedAt,
      leadingConfidence: candidates[0]?.confidence,
      preferencesChars: params.preferences?.length ?? 0,
    });
    return candidates;
  } catch (error) {
    log.warn("star map intake structured resolution unavailable", {
      elapsedMs: Date.now() - startedAt,
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
    if (directories.length === 0) {
      // Every path below ends in a list of projects to choose from, and with
      // no projects that list is empty — a heading promising options above
      // nothing, with no way forward. Name the actual problem instead.
      throw new Error(
        "No projects are registered on this instance. Add a directory first.",
      );
    }

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
        // A request that literally names one project is strong evidence, so
        // it still short-circuits — but not over the resolver's objection.
        // When the resolver ranked something else first, a raw substring hit
        // beating a reasoned pick is exactly the call the operator should
        // make, so fall through and show them both.
        const resolverAgrees =
          !leading || leading.directory.key === fuzzy[0]?.key;
        if (fuzzy.length === 1 && resolverAgrees) {
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
            // `undefined` means the resolver could not run; `[]` means it ran
            // and pointed nowhere. Collapsing the two would make the dialog
            // claim "no project matched" about a judgment never made, which
            // is the class of copy this whole surface exists to remove.
            candidateSource = fuzzy.length > 0
              ? "label"
              : resolved
                ? "recent"
                : "unresolved";
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
