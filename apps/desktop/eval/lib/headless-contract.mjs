import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const EXIT = { completed: 0, failed: 1, preflight_failed: 2, timeout: 3, cancelled: 4, budget_exceeded: 5, incomplete: 6 };
export function validateInput(input) {
  const allowed = new Set(["schemaVersion", "runId", "cwd", "prompt", "model", "reasoningEffort", "serviceTier", "tokenMiser", "timeoutMs", "profileDir", "codexHome", "runtimeManifest", "preflightOnly", "maxObservedCostUsd", "maxObservedTokens"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown input field: ${key}`);
  if (input.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.runId ?? "")) throw new Error("schemaVersion=1 and a safe runId are required");
  if (!["gpt-6.1-sol", "gpt-6-astra"].includes(input.model)) throw new Error("Unsupported model (no substitutions)");
  if (input.reasoningEffort !== "high" || input.serviceTier !== "default" || typeof input.tokenMiser !== "boolean") throw new Error("Explicit high/default/tokenMiser boolean required");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 86_400_000) throw new Error("Invalid timeoutMs");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("prompt required");
  for (const field of ["cwd", "runtimeManifest"]) if (typeof input[field] !== "string" || !path.isAbsolute(input[field])) throw new Error(`Absolute ${field} required`);
  for (const field of ["profileDir", "codexHome"]) if (input[field] !== undefined && !path.isAbsolute(input[field])) throw new Error(`Absolute ${field} required`);
  for (const field of ["maxObservedCostUsd", "maxObservedTokens"]) if (input[field] !== undefined && (!Number.isFinite(input[field]) || input[field] <= 0)) throw new Error(`Invalid ${field}`);
  if (input.preflightOnly !== undefined && typeof input.preflightOnly !== "boolean") throw new Error("Invalid preflightOnly");
  return { ...input, profileDir: input.profileDir ?? "/eval/profile", codexHome: input.codexHome ?? "/eval/codex" };
}
export function fingerprint(input) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export function atomicJson(file, value) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(path.dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function claimRun(output, input) {
  const file = path.join(output, "run.json");
  const hash = fingerprint(input);
  try {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, runId: input.runId, inputHash: hash, status: "incomplete" })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = JSON.parse(readFileSync(file, "utf8"));
    if (prior.inputHash !== hash) throw new Error("Output already belongs to a different request");
    return { file, prior, hash };
  }
  return { file, hash };
}
export function cleanEnvironment(input, home, captureRoot, source = process.env) {
  const env = {};
  for (const key of ["PATH", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TZ", "DBUS_SESSION_BUS_ADDRESS"]) if (source[key]) env[key] = source[key];
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"), CODEX_HOME: input.codexHome,
    PWRAGENT_HOME: input.profileDir, PWRAGENT_PROFILE: "default", NODE_ENV: "production",
    PWRAGENT_DEV_DISABLE_SECRET_STORAGE: "1", PWRAGENT_DISABLE_MESSAGING: "1", PWRAGENT_DISABLE_AUTOMATIONS: "1",
    PWRAGENT_DEV_EVAL_RUNTIME_MANIFEST: input.runtimeManifest,
    PWRAGENT_PROTOCOL_CAPTURE: "1", PWRAGENT_PROTOCOL_CAPTURE_ROOT: captureRoot,
  };
}
export function configToml(input, command) {
  return `[general]\nconfirm_quit_with_in_progress_threads = false\nnotifications_enabled = false\n[general.tool_output_alerts]\nmonitor_job_suggestions_enabled = false\n[onboarding]\ncompleted = true\n[federation]\nmode = "disabled"\n[messaging]\nenabled = false\n[experimental]\ntoken_miser_enabled = ${input.tokenMiser}\ntoken_miser_default_enabled = ${input.tokenMiser}\nthread_tool_accounting = true\n[models.codex]\npath = ${JSON.stringify(command)}\nmanaged_builds = true\nallow_fast = false\n[acp_agents.grok]\nenabled = false\nmanaged_builds = false\n[acp_agents.gemini]\nenabled = false\n[acp_agents.kimi]\nenabled = false\n[acp_agents.qwen]\nenabled = false\n`;
}
export function sanitizer(secrets = []) {
  const redact = (value) => {
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
      return result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(access_token|refresh_token|id_token|api_?key|authorization|accountId|accountKey|email)$/i.test(k) ? "[REDACTED]" : redact(v)]));
    return value;
  };
  return redact;
}
export function assertReady(backend, settings, input, runtime) {
  if (!backend?.available || !backend.capabilities?.startTurn || !backend.capabilities?.interruptTurn) throw new Error("Codex backend unavailable or unsupported protocol");
  if (backend.account?.requiresOpenaiAuth || !backend.account?.type) throw new Error("Codex authentication unavailable");
  const model = backend.launchpadOptions?.models?.find((m) => m.id === input.model);
  if (!model?.reasoningEfforts?.includes(input.reasoningEffort)) throw new Error("Exact model/effort missing from live provider catalog");
  const managed = settings.runtime?.tokenMiser?.managedCodex;
  if (managed?.state !== "ready" || managed.version !== runtime.version || settings.models?.codex?.discovery?.selectedCommand !== path.join(runtime.directory, "codex")) throw new Error("Managed runtime pin not effective");
  if (backend.tokenMiser?.enabled !== input.tokenMiser || backend.tokenMiser?.defaultEnabled !== input.tokenMiser) throw new Error("Token Miser settings mismatch");
  if (input.tokenMiser && settings.runtime?.tokenMiser?.activation?.state !== "active") throw new Error("Token Miser interception not active");
  if (!settings.runtime?.messaging?.disabled) throw new Error("Messaging must be disabled");
}
export function terminalEvent(event, threadId, turnId) {
  const { method, params } = event.notification ?? {};
  if (event.backend !== "codex" || params?.threadId !== threadId || params?.turnId !== turnId) return undefined;
  if (method === "turn/failed") return "failed";
  if (method === "turn/completed") return "completed";
  if (method === "turn/interrupted") return "cancelled";
  return undefined;
}
export function observedBudget(lines = []) {
  // The IPC ledger has one row per usage identity, updated in place. Never add
  // successive snapshots (or cumulative* fields) together.
  return { costUsd: lines.reduce((n, l) => n + (l.totalCostMicros ?? 0), 0) / 1e6,
    tokens: lines.reduce((n, l) => n + (l.totalTokens ?? 0), 0),
    unpriced: lines.some((l) => l.priceStatus !== "priced") };
}
