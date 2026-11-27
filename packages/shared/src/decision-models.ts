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

export type DecisionImageMimeType = "image/png" | "image/jpeg";

export const DECISION_IMAGE_MAX_COUNT = 4;
const DECISION_IMAGE_MIME_TYPES: readonly DecisionImageMimeType[] = ["image/png", "image/jpeg"];
// 512 KiB encodes to ~683 KiB, leaving room in the 1 MiB HTTP MCP body for
// the 256 KiB evidence value and the tool envelope on a registered call.
const DECISION_IMAGE_MAX_DECODED_BYTES = 512 * 1024;
const DECISION_IMAGE_LIMITS = {
  mimeTypes: DECISION_IMAGE_MIME_TYPES,
  maxImages: DECISION_IMAGE_MAX_COUNT,
  maxBytesPerImage: DECISION_IMAGE_MAX_DECODED_BYTES,
  maxTotalBytes: DECISION_IMAGE_MAX_DECODED_BYTES,
  minSide: 1,
  maxSide: 4096,
} as const;

/** PwrAgent's accepted subset of provider formats and request sizes. */
export type DecisionImageCapabilities =
  | { supported: false }
  | (Omit<typeof DECISION_IMAGE_LIMITS, "minSide" | "maxSide"> & {
      supported: true;
      experimental: boolean;
      minSide: number;
      maxSide: number;
    });

/** Used by registration, invocation, and provider disclosure. */
export function decisionImageCapabilities(
  provider: "openai" | DecisionProviderId,
  model?: string,
): DecisionImageCapabilities {
  switch (provider) {
    // https://developers.openai.com/api/docs/guides/decisions#evaluate-an-image
    case "openai":
      return { ...DECISION_IMAGE_LIMITS, supported: true, experimental: false };
    // https://huggingface.co/Cloudflare/clef-flash#jev--systemone-api
    // PwrSuiteLab's System One transport also serves the live voice camera.
    case "local":
      return /^(?:cloudflare\/)?clef(?:-flash)?$/i.test(model ?? DECISION_LOCAL_DEFAULT_MODEL)
        ? { ...DECISION_IMAGE_LIMITS, supported: true, experimental: false }
        : { supported: false };
    // https://docs.typesafe.ai/images documents Jev 1.13 and 1.14 with an
    // experimental request header, PNG/JPEG, and 280–1568 px on each side.
    // Its provider limits are 16 MiB per file and 32 MiB per request.
    // https://docs.typesafe.ai/models#aliases lists latest and preview.
    case "jev":
      return /^jev-(?:latest|preview|1\.(?:13|14)(?:\.\d+)?)$/.test(model ?? DECISION_JEV_DEFAULT_MODEL)
        ? { ...DECISION_IMAGE_LIMITS, supported: true, experimental: true, minSide: 280, maxSide: 1568 }
        : { supported: false };
  }
}

export function decisionImageCapabilityLabel(capability: DecisionImageCapabilities): string {
  if (!capability.supported) return "Images unavailable for this model";
  const limits = `up to ${capability.maxImages} PNG or JPEG images`;
  return capability.experimental ? `Experimental image input · ${limits}` : `Image input · ${limits}`;
}

/** A model id a provider accepts, as Settings lists it. */
export type DecisionModelInfo = {
  id: string;
  description?: string;
};

/**
 * The models PwrAgent knows each provider accepts, so Settings can offer a
 * choice before the provider has been asked. Default first.
 * https://docs.typesafe.ai/models lists Jev's aliases and versioned ids;
 * PwrSuiteLab's Clef runtime serves only clef-flash.
 */
export const DECISION_KNOWN_MODELS: Record<DecisionProviderId, readonly DecisionModelInfo[]> = {
  local: [
    { id: DECISION_LOCAL_DEFAULT_MODEL, description: "Cloudflare's Clef, as PwrSuiteLab serves it" },
  ],
  jev: [
    { id: DECISION_JEV_DEFAULT_MODEL, description: "The newest stable Jev" },
    { id: "jev-preview", description: "Jev's preview build, when there is one" },
    { id: "jev-1.14.0", description: "Jev 1.14, pinned" },
    { id: "jev-1.13.0", description: "Jev 1.13, pinned" },
  ],
};

/** What a provider's `GET /v1/models` answered, for the Model picker. */
export type DecisionModelListing =
  | { ok: true; models: DecisionModelInfo[] }
  | { ok: false; detail: string };

export type DecisionModelOption = DecisionModelInfo & {
  /** listed: the provider offers it now; known: PwrAgent's catalog; saved: only in Settings. */
  source: "listed" | "known" | "saved";
};

/**
 * The Model picker's choices: what the provider lists, then the known
 * models it did not list, then a saved id neither mentions, so the saved
 * model is always a choice and no id appears twice. The default model
 * leads its group.
 */
export function decisionModelOptions(input: {
  provider: DecisionProviderId;
  saved?: string;
  listed?: readonly DecisionModelInfo[];
}): DecisionModelOption[] {
  const fallback = input.provider === "local" ? DECISION_LOCAL_DEFAULT_MODEL : DECISION_JEV_DEFAULT_MODEL;
  const known = DECISION_KNOWN_MODELS[input.provider];
  const seen = new Set<string>();
  const options: DecisionModelOption[] = [];
  const add = (model: DecisionModelInfo, source: DecisionModelOption["source"]) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const description = model.description?.trim()
      || known.find((entry) => entry.id === id)?.description;
    options.push({ id, ...(description ? { description } : {}), source });
  };
  const defaultFirst = (models: readonly DecisionModelInfo[]) =>
    [...models].sort((a, b) => Number(b.id.trim() === fallback) - Number(a.id.trim() === fallback));
  for (const model of defaultFirst(input.listed ?? [])) add(model, "listed");
  for (const model of known) add(model, "known");
  add({ id: input.saved ?? fallback }, "saved");
  return options;
}

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

/** Every provider an agent can run a decision on, in the order agents prefer them. */
export type DecisionRunProvider = "openai" | DecisionProviderId;

export type DecisionProviderReadinessInput = {
  decisionModels: DesktopDecisionModelSettings | undefined;
  /** OpenAI Decisions is on in Settings (the default). */
  openaiEnabled: boolean;
  openaiKey: boolean;
  jevKey: boolean;
};

export type DecisionProviderReadiness = {
  provider: DecisionRunProvider;
  enabled: boolean;
  /** Settings hold everything an agent needs to run a decision on it. */
  ready: boolean;
  /**
   * What an enabled provider that is not ready lacks: an API key, or, for
   * the local model, being chosen as the decision model.
   */
  missing?: "key" | "choice";
};

export type DecisionProvidersReadiness = {
  /** OpenAI Decisions, TypeSafe Jev, then the local model. */
  providers: DecisionProviderReadiness[];
  /** The provider a decision that names none runs on. */
  defaultProvider: DecisionRunProvider;
};

/**
 * What the Decisions tab and its setup dialog say about each provider, and
 * which one an agent gets by default. The default follows the owner's
 * pick (`resolveDefaultDecisionProvider`): OpenAI when it is on with a key,
 * else the decision model chosen under Defaults → Decisions, else Jev when
 * it is on with a key, else the first provider that is on. A local model
 * counts as ready only once it is chosen: nothing says a server is running
 * at the default address until the operator says so.
 */
export function decisionProvidersReadiness(input: DecisionProviderReadinessInput): DecisionProvidersReadiness {
  const resolved = resolveDecisionModelSettings(input.decisionModels);
  const enabled: Record<DecisionRunProvider, boolean> = {
    openai: input.openaiEnabled,
    jev: resolved.enabled.jev,
    local: resolved.enabled.local,
  };
  const ready: Record<DecisionRunProvider, boolean> = {
    openai: enabled.openai && input.openaiKey,
    jev: enabled.jev && input.jevKey,
    local: enabled.local && resolved.model === "local",
  };
  const order: DecisionRunProvider[] = ["openai", "jev", "local"];
  const providers = order.map((provider): DecisionProviderReadiness => ({
    provider,
    enabled: enabled[provider],
    ready: ready[provider],
    ...(enabled[provider] && !ready[provider] ? { missing: provider === "local" ? "choice" : "key" } : {}),
  }));
  const chosen = resolved.model;
  const defaultProvider: DecisionRunProvider = ready.openai
    ? "openai"
    : chosen === "jev" || chosen === "local"
      ? chosen
      : ready.jev
        ? "jev"
        : order.find((provider) => enabled[provider]) ?? "openai";
  return { providers, defaultProvider };
}

/** Providers currently enabled and configured to run decisions, in preference order. */
export function readyDecisionProviders(
  readiness: Pick<DecisionProvidersReadiness, "providers"> | undefined,
): DecisionRunProvider[] {
  if (!readiness) return [];
  return readiness.providers.filter((entry) => entry.ready).map((entry) => entry.provider);
}

/** Human-readable provider label for prompts and setup surfaces. */
export function decisionRunProviderName(provider: DecisionRunProvider): string {
  switch (provider) {
    case "openai": return "OpenAI Decisions (gpt-6-luna)";
    case "jev": return "TypeSafe Jev";
    case "local": return "local Clef";
  }
}
