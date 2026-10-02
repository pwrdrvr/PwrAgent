import {
  FEDERATION_SHORT_NAME_KEEP_LENGTH,
  FEDERATION_SHORT_NAME_MAX_LENGTH,
  federationShortNameKey,
  federationShortNameLength,
  normalizeFederationShortName,
  type FederationHostInfo,
} from "@pwragent/shared";

/**
 * One machine in the short-name prompt. Instances are grouped by full
 * label, because two profiles of one machine share a label and must share
 * a short name; the profile is drawn beside the name separately.
 */
export type FederationShortNameMachine = {
  label: string;
  profiles: string[];
  host?: FederationHostInfo;
  /** The machine's current auto short name, when every check still passes. */
  current?: string;
  /** The operator's name for the machine. Fixed: never sent for renaming. */
  override?: string;
};

export type FederationShortNamePlan = {
  /** Machines the model names: long labels without an operator override. */
  candidates: FederationShortNameMachine[];
  /** Names the model may not use: overrides, and labels short enough to keep. */
  reserved: Array<{ label: string; name: string; reason: "override" | "short" }>;
};

export function planFederationShortNames(
  machines: readonly FederationShortNameMachine[],
): FederationShortNamePlan {
  const candidates: FederationShortNameMachine[] = [];
  const reserved: FederationShortNamePlan["reserved"] = [];
  for (const machine of machines) {
    if (machine.override) {
      reserved.push({ label: machine.label, name: machine.override, reason: "override" });
    } else if (federationShortNameLength(machine.label) <= FEDERATION_SHORT_NAME_KEEP_LENGTH) {
      reserved.push({ label: machine.label, name: machine.label, reason: "short" });
    } else {
      candidates.push(machine);
    }
  }
  return { candidates, reserved };
}

/**
 * Whether the gateway has to ask the model: a long label has no current
 * name (a new machine, or a renamed one), or the current names no longer
 * tell the machines apart (a machine joined whose kept label or override
 * collides with an existing short name). A machine leaving never asks.
 *
 * Only a collision the model can fix counts. Two reserved names that clash
 * (two kept labels differing in case) stay clashing whatever it answers.
 */
export function federationShortNamesNeedGeneration(
  machines: readonly FederationShortNameMachine[],
): boolean {
  const plan = planFederationShortNames(machines);
  if (plan.candidates.some((machine) => !machine.current)) return true;
  const seen = new Set(plan.reserved.map((entry) => federationShortNameKey(entry.name)));
  for (const machine of plan.candidates) {
    const key = federationShortNameKey(machine.current!);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * The identity of one generation's input. The coordinator remembers which
 * inputs it already tried this process, so a failed or rejected answer is
 * not retried on every reconnect — only when the input changes.
 */
export function federationShortNameInputKey(
  machines: readonly FederationShortNameMachine[],
): string {
  return JSON.stringify(
    [...machines]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((machine) => [
        machine.label,
        machine.current ?? "",
        machine.override ?? "",
      ]),
  );
}

export const FEDERATION_SHORT_NAME_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          shortName: { type: "string" },
        },
        required: ["label", "shortName"],
        additionalProperties: false,
      },
    },
  },
  required: ["names"],
  additionalProperties: false,
};

export const FEDERATION_SHORT_NAME_SYSTEM_PROMPT = [
  "You name the machines in an operator's PwrAgent federation. Each name is",
  "drawn on small chips and map markers where the full machine label does",
  "not fit, so the operator must recognise each machine from its name alone.",
  "Rules:",
  `- At most ${FEDERATION_SHORT_NAME_MAX_LENGTH} characters, spaces included, and`,
  "  never longer than the machine's label. Shorter is better.",
  "- Every name must differ from every other name and from every reserved",
  "  name, ignoring case.",
  "- Name what tells the machines apart: chip and tier (M5 Max, M4 Mini),",
  "  model year (2018 MBP), the OS for a machine that is not a Mac (Win PC,",
  "  Linux box). Use only what the label and host facts support. Call a",
  "  machine a VM only when its facts say vm=yes.",
  "- Keep stability: a machine with a current name keeps it unless the set",
  "  now needs it to change to stay unambiguous. When the machines need a",
  "  distinction the current names do not make (a second M5 Max joins),",
  "  rename whichever machines need it, or rename them all from scratch if",
  "  that gives a clearer scheme.",
  "- Profiles are context only. They are drawn next to the name, so never",
  "  put a profile in a name.",
  "- Return exactly one entry for every machine under \"Name these\", with",
  "  its label copied exactly.",
  "Return JSON matching the schema exactly.",
].join("\n");

export function buildFederationShortNamePrompt(
  plan: FederationShortNamePlan,
): string {
  const lines: string[] = [];
  if (plan.reserved.length > 0) {
    lines.push("Reserved names (fixed; no other machine may use them):");
    for (const entry of plan.reserved) {
      lines.push(
        entry.reason === "override"
          ? `- "${entry.name}": the operator's name for ${entry.label}`
          : `- "${entry.name}": label already short, kept as is`,
      );
    }
    lines.push("");
  }
  lines.push("Name these:");
  for (const machine of plan.candidates) {
    lines.push(`- ${describeMachine(machine)}`);
  }
  return lines.join("\n");
}

function describeMachine(machine: FederationShortNameMachine): string {
  const parts = [`label=${machine.label}`];
  parts.push(`current=${machine.current ?? "(none)"}`);
  if (machine.profiles.length > 0) {
    parts.push(`profiles=${machine.profiles.join(", ")}`);
  }
  const host = machine.host;
  if (host) {
    const os = osName(host.platform);
    if (os) parts.push(`os=${os}${host.osVersion ? ` ${host.osVersion}` : ""}`);
    if (host.arch) parts.push(`arch=${host.arch}`);
    if (host.cpuModel) parts.push(`cpu=${host.cpuModel}`);
    if (host.cpuCount) parts.push(`cores=${host.cpuCount}`);
    if (host.memoryBytes) {
      parts.push(`memory=${Math.round(host.memoryBytes / 1024 ** 3)} GB`);
    }
    if (host.virtualMachine !== undefined) {
      parts.push(`vm=${host.virtualMachine ? "yes" : "no"}`);
    }
  }
  return parts.join(" | ");
}

function osName(platform: string | undefined): string | undefined {
  switch (platform) {
    case undefined:
      return undefined;
    case "darwin":
      return "macOS (Darwin kernel)";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

export type FederationShortNameValidation =
  | { ok: true; names: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Check a model answer by rule. Any failure rejects the whole answer: a
 * partial map would mix a fresh scheme with names chosen against the old
 * one, and the caller keeps every current name instead.
 */
export function validateFederationShortNameAnswer(
  answer: unknown,
  plan: FederationShortNamePlan,
): FederationShortNameValidation {
  const names = (answer as { names?: unknown } | null)?.names;
  if (!Array.isArray(names)) {
    return { ok: false, reason: "answer_not_a_list" };
  }
  const wanted = new Map(plan.candidates.map((machine) => [machine.label, machine]));
  const taken = new Map(
    plan.reserved.map((entry) => [federationShortNameKey(entry.name), entry.label]),
  );
  // A name may not be another machine's full label either, the rule an
  // operator rename follows: two machines would look alike.
  const labels = new Map(
    [...plan.candidates, ...plan.reserved].map((machine) => [
      federationShortNameKey(machine.label),
      machine.label,
    ]),
  );
  const result = new Map<string, string>();
  for (const entry of names) {
    const record = entry as { label?: unknown; shortName?: unknown } | null;
    const label = typeof record?.label === "string" ? record.label : undefined;
    if (!label || !wanted.has(label)) {
      return { ok: false, reason: "unknown_label" };
    }
    if (result.has(label)) {
      return { ok: false, reason: "duplicate_label" };
    }
    const name = normalizeFederationShortName(record?.shortName);
    if (!name) {
      return { ok: false, reason: "invalid_name" };
    }
    if (federationShortNameLength(name) > federationShortNameLength(label)) {
      return { ok: false, reason: "name_longer_than_label" };
    }
    const key = federationShortNameKey(name);
    const labelOwner = labels.get(key);
    if (taken.has(key) || (labelOwner !== undefined && labelOwner !== label)) {
      return { ok: false, reason: "name_not_unique" };
    }
    taken.set(key, label);
    result.set(label, name);
  }
  if (result.size !== wanted.size) {
    return { ok: false, reason: "missing_label" };
  }
  return { ok: true, names: result };
}

/**
 * The model for short-name turns. Undefined defers to the Codex client's
 * helper default (`getDefaultHelperModel`: gpt-6-luna when the backend
 * offers it, otherwise the thread-title helper model). This is the one seam
 * a Default Models setting replaces.
 */
export function resolveFederationShortNameModel(): string | undefined {
  return undefined;
}

/**
 * Protocol round-trip budget, per request. `runHelperStructuredTurn`
 * applies it to each of its calls (thread start, turn start, cleanup), not
 * as a total, so it stays at the helper default.
 */
export const FEDERATION_SHORT_NAME_TIMEOUT_MS = 20_000;
/**
 * How long the model may take to answer. The prompt is a few lines per
 * machine and the answer is a short list, but the title helper's 20s was
 * sized for one line from one message, and a timeout here costs nothing but
 * a later retry — the full labels stay up meanwhile. Err long.
 */
export const FEDERATION_SHORT_NAME_TURN_TIMEOUT_MS = 60_000;

export type FederationStructuredGenerator = (params: {
  backend: "codex";
  model?: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  timeoutMs: number;
  turnTimeoutMs: number;
}) => Promise<
  | { status: "ok"; object: unknown; model?: string }
  | { status: string; reason?: string }
>;

export type FederationShortNameGenerationResult =
  | { ok: true; names: Map<string, string>; model?: string }
  /** `answered`: the model replied, and the reply failed validation. */
  | { ok: false; reason: string; answered: boolean };

/** Ask the helper model once, and validate the answer. */
export async function generateFederationShortNames(params: {
  plan: FederationShortNamePlan;
  generate: FederationStructuredGenerator;
}): Promise<FederationShortNameGenerationResult> {
  let result;
  try {
    result = await params.generate({
      backend: "codex",
      model: resolveFederationShortNameModel(),
      system: FEDERATION_SHORT_NAME_SYSTEM_PROMPT,
      prompt: buildFederationShortNamePrompt(params.plan),
      schema: FEDERATION_SHORT_NAME_SCHEMA,
      schemaName: "federation_instance_short_names",
      timeoutMs: FEDERATION_SHORT_NAME_TIMEOUT_MS,
      turnTimeoutMs: FEDERATION_SHORT_NAME_TURN_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      answered: false,
    };
  }
  if (result.status !== "ok" || !("object" in result)) {
    return {
      ok: false,
      reason: ("reason" in result ? result.reason : undefined) ?? result.status,
      answered: false,
    };
  }
  const validation = validateFederationShortNameAnswer(result.object, params.plan);
  if (!validation.ok) return { ...validation, answered: true };
  return { ok: true, names: validation.names, model: result.model };
}
