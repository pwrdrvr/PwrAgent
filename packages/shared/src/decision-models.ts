/**
 * Decision models answer typed questions (choice, score, yes/no) with a
 * probability for every allowed answer instead of generating text. PwrAgent
 * knows two providers: a local one (Cloudflare's Clef, served on this Mac,
 * for example by PwrSuiteLab's Clef runtime) and TypeSafe's hosted Jev.
 * Both speak TypeSafe's System One API, so they differ only in where requests
 * go, which key they carry, and which model they name.
 */
export type DecisionProviderId = "local" | "jev";
export type DecisionModelChoice = DecisionProviderId | "off";

export const DECISION_PROVIDER_IDS = ["local", "jev"] as const satisfies readonly DecisionProviderId[];

/** Appended to a provider's base URL, as TypeSafe's SDK does. */
export const DECISION_SYSTEM_ONE_PATH = "/v1/systemone";
export const DECISION_LOCAL_DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
/** PwrSuiteLab's Clef runtime accepts this model id and rejects any other. */
export const DECISION_LOCAL_DEFAULT_MODEL = "clef-flash";
export const DECISION_JEV_ENDPOINT = "https://api.typesafe.ai";
export const DECISION_JEV_DEFAULT_MODEL = "jev-latest";

/** Where to try each provider, for the Settings rows that suggest them. */
export const DECISION_PROVIDER_LINKS = {
  clefModel: "https://huggingface.co/Cloudflare/clef-flash",
  clefAnnouncement: "https://blog.cloudflare.com/clef-decision-models/",
  jevDocs: "https://docs.typesafe.ai/",
  jevConsole: "https://console.typesafe.ai/",
} as const;

export type DesktopDecisionModelSettings = {
  /** The decision model PwrAgent uses. Absent = off: nothing is set up. */
  model?: DecisionModelChoice;
  /** Live voice sends camera frames to the decision model. Absent = on. */
  cameraCues?: boolean;
  local?: {
    /** Agents may run decisions on it and live voice may use it. Absent = on. */
    enabled?: boolean;
    /** Base URL of the local server. Absent = {@link DECISION_LOCAL_DEFAULT_ENDPOINT}. */
    endpoint?: string;
    /** Absent = {@link DECISION_LOCAL_DEFAULT_MODEL}. */
    model?: string;
  };
  jev?: {
    /** Agents may run decisions on it. Absent = on. */
    enabled?: boolean;
    /** Absent = {@link DECISION_JEV_DEFAULT_MODEL}. */
    model?: string;
  };
};

export type DecisionModelResolution = {
  /**
   * The decision model in effect: the saved choice, or "off" while that
   * provider is turned off. Turning it back on restores the choice.
   */
  model: DecisionModelChoice;
  /** The saved choice, whether or not its provider is on. */
  chosenModel: DecisionModelChoice;
  enabled: Record<DecisionProviderId, boolean>;
  localEndpoint: string;
  localModel: string;
  jevModel: string;
  cameraCues: boolean;
};

export function resolveDecisionModelSettings(
  settings: DesktopDecisionModelSettings | undefined,
): DecisionModelResolution {
  const chosenModel = settings?.model ?? "off";
  const enabled = {
    local: settings?.local?.enabled ?? true,
    jev: settings?.jev?.enabled ?? true,
  };
  return {
    model: chosenModel !== "off" && !enabled[chosenModel] ? "off" : chosenModel,
    chosenModel,
    enabled,
    localEndpoint: settings?.local?.endpoint ?? DECISION_LOCAL_DEFAULT_ENDPOINT,
    localModel: settings?.local?.model ?? DECISION_LOCAL_DEFAULT_MODEL,
    jevModel: settings?.jev?.model ?? DECISION_JEV_DEFAULT_MODEL,
    cameraCues: settings?.cameraCues ?? true,
  };
}

type ParsedLocalEndpoint = { scheme: string; host: string; port?: string };

/** Hand-parsed: this package runs without DOM or Node globals, so no `URL`. */
function parseLocalEndpoint(endpoint: string): ParsedLocalEndpoint | string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)([?#].*)?$/.exec(endpoint.trim());
  if (!match) return "Enter a URL such as http://127.0.0.1:8787.";
  const scheme = match[1]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "Use an http or https URL.";
  const authority = match[2]!;
  if (authority.includes("@")) return "Remove the user name and password from the URL.";
  if ((match[3] && match[3] !== "/") || match[4]) return "Enter only the server address, without a path.";
  const hostPort = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hostPort || (hostPort[2] !== undefined && Number(hostPort[2]) > 65535)) {
    return "Enter a URL such as http://127.0.0.1:8787.";
  }
  return { scheme, host: hostPort[1]!.toLowerCase(), port: hostPort[2] };
}

/**
 * A local endpoint must be an http(s) URL on this Mac with no path, query,
 * credentials or fragment. Camera frames go only to it, so "local" means
 * loopback, not merely the local network. Returns the problem, or undefined.
 */
export function decisionLocalEndpointProblem(endpoint: string): string | undefined {
  const parsed = parseLocalEndpoint(endpoint);
  if (typeof parsed === "string") return parsed;
  const host = parsed.host.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
  return loopback ? undefined : "Use an address on this Mac, such as 127.0.0.1 or localhost.";
}

/** The base URL in the one spelling the client builds paths from. */
export function normalizeDecisionLocalEndpoint(endpoint: string): string | undefined {
  if (decisionLocalEndpointProblem(endpoint)) return undefined;
  const parsed = parseLocalEndpoint(endpoint) as ParsedLocalEndpoint;
  return `${parsed.scheme}://${parsed.host}${parsed.port ? `:${parsed.port}` : ""}`;
}

export type DecisionCameraCueAvailability =
  | { available: true; endpoint: string; model: string }
  | { available: false; reason: string };

/** Camera frames never leave this Mac: cues need the local decision model. */
export function decisionCameraCueAvailability(
  settings: DesktopDecisionModelSettings | undefined,
): DecisionCameraCueAvailability {
  const resolved = resolveDecisionModelSettings(settings);
  if (!resolved.enabled.local && resolved.chosenModel === "local") {
    return { available: false, reason: "The local decision model is off in Settings → AI Providers." };
  }
  if (resolved.model === "off") {
    return { available: false, reason: "Choose a decision model in Settings → AI Providers to use camera cues." };
  }
  if (!resolved.cameraCues) {
    return { available: false, reason: "Camera cues are off in Settings → AI Providers." };
  }
  if (resolved.model !== "local") {
    return { available: false, reason: "Camera cues need the local decision model, so frames stay on this Mac." };
  }
  return { available: true, endpoint: resolved.localEndpoint, model: resolved.localModel };
}

/** Result of a Settings "Check" on a decision provider. */
export type DecisionProviderCheck =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

/** A model id: trimmed, non-blank, at most 200 characters. */
function modelId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length <= 200 ? value.trim() || undefined : undefined;
}

/**
 * Drops what this build cannot use: an unknown model choice, a local endpoint
 * that is not on this Mac, a blank model id. A provider that is on drops its
 * `enabled` key, since on is the default. Returns undefined when nothing
 * is left, so an all-default section is not written.
 */
export function normalizeDecisionModelSettings(value: {
  model?: unknown;
  cameraCues?: unknown;
  localEndpoint?: unknown;
  localModel?: unknown;
  jevModel?: unknown;
  localEnabled?: unknown;
  jevEnabled?: unknown;
}): DesktopDecisionModelSettings | undefined {
  const model = value.model === "local" || value.model === "jev" || value.model === "off" ? value.model : undefined;
  const cameraCues = typeof value.cameraCues === "boolean" ? value.cameraCues : undefined;
  const endpoint = typeof value.localEndpoint === "string" ? normalizeDecisionLocalEndpoint(value.localEndpoint) : undefined;
  const localModel = modelId(value.localModel);
  const jevModel = modelId(value.jevModel);
  // Only "off" is written: on is the default, so an absent key means on.
  const localOff = value.localEnabled === false;
  const jevOff = value.jevEnabled === false;
  const local = {
    ...(localOff ? { enabled: false } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(localModel ? { model: localModel } : {}),
  };
  const jev = { ...(jevOff ? { enabled: false } : {}), ...(jevModel ? { model: jevModel } : {}) };
  if (model === undefined && cameraCues === undefined && !Object.keys(local).length && !Object.keys(jev).length) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(cameraCues === undefined ? {} : { cameraCues }),
    ...(Object.keys(local).length ? { local } : {}),
    ...(Object.keys(jev).length ? { jev } : {}),
  };
}
