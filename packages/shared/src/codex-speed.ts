import type { BackendModelOption } from "./contracts/backend";

export type CodexSpeed = "standard" | "fast" | "ultrafast";

export function codexSpeedOptions(
  model: BackendModelOption | undefined,
  allowed = true,
  legacySupportsFast = false,
): CodexSpeed[] {
  const options: CodexSpeed[] = ["standard"];
  if (!allowed) {
    return options;
  }
  if (model?.supportsFast ?? legacySupportsFast) {
    options.push("fast");
  }
  // Never infer Ultrafast from a model id. Empty or missing catalog tiers
  // must keep it unavailable on older runtimes and accounts without access.
  if (model?.serviceTiers?.includes("ultrafast")) {
    options.push("ultrafast");
  }
  return options;
}

export function selectedCodexSpeed(settings: {
  serviceTier?: string | null;
  fastMode?: boolean;
}): CodexSpeed {
  if (settings.serviceTier === "ultrafast") {
    return "ultrafast";
  }
  if (settings.fastMode !== undefined) {
    return settings.fastMode ? "fast" : "standard";
  }
  return settings.serviceTier === "fast"
    || settings.serviceTier === "priority"
    ? "fast"
    : "standard";
}

export function codexSpeedSettings(speed: CodexSpeed): {
  serviceTier: string | undefined;
  fastMode: boolean;
} {
  return {
    serviceTier: speed === "ultrafast" ? "ultrafast" : undefined,
    fastMode: speed === "fast",
  };
}

export function nextCodexSpeed(
  options: CodexSpeed[],
  settings: { serviceTier?: string | null; fastMode?: boolean },
): CodexSpeed {
  return options[(options.indexOf(selectedCodexSpeed(settings)) + 1) % options.length]
    ?? "standard";
}
