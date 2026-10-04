/**
 * Decision models answer typed questions (choice, score, yes/no) with a
 * probability for every allowed answer instead of generating text. PwrAgent
 * knows two providers: a local one (Cloudflare's Clef, served on this Mac,
 * for example by PwrSuiteLab's Clef runtime) and TypeSafe's hosted Jev.
 */
export type DecisionProviderId = "local" | "jev";
export type DecisionModelChoice = DecisionProviderId | "off";

export const DECISION_PROVIDER_IDS = ["local", "jev"] as const satisfies readonly DecisionProviderId[];

export const DECISION_LOCAL_DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
export const DECISION_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DECISION_JEV_DEFAULT_MODEL = "jev-latest";

/** Where to try each provider, for the Settings rows that suggest them. */
export const DECISION_PROVIDER_LINKS = {
  clefModel: "https://huggingface.co/Cloudflare/clef-flash",
  clefAnnouncement: "https://blog.cloudflare.com/clef-decision-models/",
  jevDocs: "https://docs.typesafe.ai/",
  jevConsole: "https://console.typesafe.ai/",
} as const;

export type DesktopDecisionModelSettings = {
  /** The decision model PwrAgent uses. Absent = the local model. */
  model?: DecisionModelChoice;
  /** Live voice sends camera frames to the decision model. Absent = on. */
  cameraCues?: boolean;
  local?: {
    /** Base URL of the local server. Absent = {@link DECISION_LOCAL_DEFAULT_ENDPOINT}. */
    endpoint?: string;
  };
  jev?: {
    /** Absent = {@link DECISION_JEV_DEFAULT_MODEL}. */
    model?: string;
  };
};

export type DecisionModelResolution = {
  model: DecisionModelChoice;
  localEndpoint: string;
  jevModel: string;
  cameraCues: boolean;
};

export function resolveDecisionModelSettings(
  settings: DesktopDecisionModelSettings | undefined,
): DecisionModelResolution {
  return {
    model: settings?.model ?? "local",
    localEndpoint: settings?.local?.endpoint ?? DECISION_LOCAL_DEFAULT_ENDPOINT,
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
  | { available: true; endpoint: string }
  | { available: false; reason: string };

/** Camera frames never leave this Mac: cues need the local decision model. */
export function decisionCameraCueAvailability(
  settings: DesktopDecisionModelSettings | undefined,
): DecisionCameraCueAvailability {
  const resolved = resolveDecisionModelSettings(settings);
  if (!resolved.cameraCues) {
    return { available: false, reason: "Camera cues are off in Settings → AI Providers." };
  }
  if (resolved.model !== "local") {
    return { available: false, reason: "Camera cues need the local decision model, so frames stay on this Mac." };
  }
  return { available: true, endpoint: resolved.localEndpoint };
}

/** Result of a Settings "Check" on a decision provider. */
export type DecisionProviderCheck =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

/**
 * Drops what this build cannot use: an unknown model choice, a local endpoint
 * that is not on this Mac, a blank Jev model. Returns undefined when nothing
 * is left, so an all-default section is not written.
 */
export function normalizeDecisionModelSettings(value: {
  model?: unknown;
  cameraCues?: unknown;
  localEndpoint?: unknown;
  jevModel?: unknown;
}): DesktopDecisionModelSettings | undefined {
  const model = value.model === "local" || value.model === "jev" || value.model === "off" ? value.model : undefined;
  const cameraCues = typeof value.cameraCues === "boolean" ? value.cameraCues : undefined;
  const endpoint = typeof value.localEndpoint === "string" ? normalizeDecisionLocalEndpoint(value.localEndpoint) : undefined;
  const jevModel = typeof value.jevModel === "string" && value.jevModel.trim().length <= 200
    ? value.jevModel.trim() || undefined
    : undefined;
  if (model === undefined && cameraCues === undefined && endpoint === undefined && jevModel === undefined) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(cameraCues === undefined ? {} : { cameraCues }),
    ...(endpoint ? { local: { endpoint } } : {}),
    ...(jevModel ? { jev: { model: jevModel } } : {}),
  };
}
