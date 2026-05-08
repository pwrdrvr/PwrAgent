import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MessagingCredentialValidationResult } from "@pwragent/messaging-interface";
import type {
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
  SettingsCredentialTestStatus,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import type { CredentialValidationRequest } from "../messaging/messaging-runtime";

const execFileAsync = promisify(execFile);

const log = getMainLogger("pwragent:credential-tester");

/**
 * Default per-probe timeout. The Codex subprocess is bounded here.
 * The Grok HTTP probe wraps fetch in an AbortController capped at
 * this value.
 *
 * Telegram / Discord probes are dispatched through the messaging
 * runtime, which delegates to the provider's real library (grammy /
 * discord.js). Those use the SDK's own timeout machinery and are
 * NOT bounded by this AbortController. Keep an eye on this if a
 * smoke check ever hangs longer than 8 seconds.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Cap on stored error messages — never surface a giant stack to the renderer. */
const ERROR_MESSAGE_LIMIT = 240;

/**
 * Each probe needs only a tiny slice of the settings service: the
 * resolved secret (or path), and an entry into the messaging runtime
 * for messaging probes. Pulled in via this interface so tests can stub
 * each piece independently.
 */
export interface CredentialTesterDependencies {
  resolveTelegramBotToken: () => string | undefined;
  resolveDiscordBotToken: () => string | undefined;
  resolveMattermostBotToken: () => string | undefined;
  resolveSlackBotToken: () => string | undefined;
  /** Returns the configured Mattermost server URL (settings/env merged).
   *  Used together with the bot token to target the `users/me` probe. */
  resolveMattermostServerUrl: () => string | undefined;
  resolveGrokApiKey: () => Promise<string | undefined>;
  resolveCodexCommand: () => Promise<string | undefined>;
  /**
   * Routes Telegram / Discord credential validation through the
   * channel-neutral messaging runtime, which dynamically imports the
   * matching provider package and calls its `validateCredentials`.
   * Tests stub this to avoid loading the provider packages.
   *
   * Request shape is owned by the runtime
   * (`CredentialValidationRequest` in `messaging-runtime.ts`) so a
   * future platform addition is one type extension instead of two.
   */
  validateMessagingCredentials: (
    request: CredentialValidationRequest,
  ) => Promise<MessagingCredentialValidationResult>;
  /** Override `fetch` for testing. Defaults to `globalThis.fetch`.
   *  Only used by the Grok probe — there is no `@ai-sdk/xai` smoke
   *  check API, so the tester falls back to a direct `GET /v1/models`. */
  fetch?: typeof fetch;
  /** Override the codex `--version` runner. Defaults to spawning the binary. */
  runCodexVersion?: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override the probe timeout (ms). Applied to the Grok HTTP fetch
   *  and the Codex subprocess; messaging probes use their library's
   *  own timeout. */
  timeoutMs?: number;
}

interface GrokModelsResponse {
  data?: Array<{ id?: string }>;
  error?: { message?: string };
}

/**
 * Tests a configured credential against its provider. Stateless beyond
 * a tiny "last result per kind" cache used purely for renderer
 * convenience — the renderer can ask "what was the last result?"
 * without having to re-probe on every settings-pane mount.
 *
 * Each probe re-resolves the credential before running, so the
 * tester always uses the freshest token / path even if settings
 * changed mid-session.
 *
 * Architecture:
 *
 * - **Telegram / Discord**: dispatched through the messaging runtime,
 *   which dynamically imports the matching provider package and calls
 *   its `validateCredentials` function. Provider SDKs (grammy /
 *   discord.js) stay isolated to their own packages; the desktop
 *   tester has zero static knowledge of either. Provider modules
 *   are loaded on first invocation and cached by Node's module
 *   registry, so subsequent tests reuse the same module without
 *   re-loading.
 * - **Grok**: direct `GET https://api.x.ai/v1/models` via fetch. The
 *   `@ai-sdk/xai` package agent-core uses doesn't expose a smoke-check
 *   API (no `models.list()`), so per the user's "use real library
 *   unless it doesn't have a non-disruptive method" clause, raw fetch
 *   is the right choice here.
 * - **Codex**: spawn `<resolved-path> --version`. There's no library
 *   to use; Codex is a binary.
 */
export class CredentialTester {
  private readonly deps: Required<
    Omit<
      CredentialTesterDependencies,
      "fetch" | "runCodexVersion" | "timeoutMs"
    >
  > & {
    fetch: typeof fetch;
    runCodexVersion: NonNullable<
      CredentialTesterDependencies["runCodexVersion"]
    >;
    timeoutMs: number;
  };
  private readonly lastResults = new Map<
    SettingsCredentialTestKind,
    SettingsCredentialTestResult
  >();

  constructor(dependencies: CredentialTesterDependencies) {
    this.deps = {
      resolveTelegramBotToken: dependencies.resolveTelegramBotToken,
      resolveDiscordBotToken: dependencies.resolveDiscordBotToken,
      resolveMattermostBotToken: dependencies.resolveMattermostBotToken,
      resolveSlackBotToken: dependencies.resolveSlackBotToken,
      resolveMattermostServerUrl: dependencies.resolveMattermostServerUrl,
      resolveGrokApiKey: dependencies.resolveGrokApiKey,
      resolveCodexCommand: dependencies.resolveCodexCommand,
      validateMessagingCredentials: dependencies.validateMessagingCredentials,
      fetch:
        dependencies.fetch
        ?? ((input, init) => globalThis.fetch(input, init)),
      runCodexVersion:
        dependencies.runCodexVersion ?? defaultRunCodexVersion,
      timeoutMs: dependencies.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    };
  }

  async test(
    kind: SettingsCredentialTestKind,
  ): Promise<SettingsCredentialTestResult> {
    const startedAt = Date.now();
    let result: SettingsCredentialTestResult;
    try {
      result = await this.runProbe(kind, startedAt);
    } catch (error) {
      result = {
        kind,
        status: "failed",
        testedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        errorMessage: clipError(error),
      };
    }
    this.lastResults.set(kind, result);
    log.debug("credential test", {
      kind,
      status: result.status,
      durationMs: result.durationMs,
    });
    return result;
  }

  lastResult(
    kind: SettingsCredentialTestKind,
  ): SettingsCredentialTestResult | undefined {
    return this.lastResults.get(kind);
  }

  /** For tests only — drop cached results. */
  resetForTests(): void {
    this.lastResults.clear();
  }

  private async runProbe(
    kind: SettingsCredentialTestKind,
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    switch (kind) {
      case "telegram":
        return await this.testTelegram(startedAt);
      case "discord":
        return await this.testDiscord(startedAt);
      case "grok":
        return await this.testGrok(startedAt);
      case "codex":
        return await this.testCodex(startedAt);
      case "mattermost":
        return await this.testMattermost(startedAt);
      case "slack":
        return await this.testSlack(startedAt);
      default: {
        const exhaustive: never = kind;
        throw new Error(`unknown credential test kind: ${exhaustive as string}`);
      }
    }
  }

  private async testTelegram(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const botToken = this.deps.resolveTelegramBotToken();
    if (!botToken) {
      return unset("telegram", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "telegram",
      credential: { botToken },
    });
    return liftMessagingResult("telegram", result);
  }

  private async testDiscord(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const botToken = this.deps.resolveDiscordBotToken();
    if (!botToken) {
      return unset("discord", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "discord",
      credential: { botToken },
    });
    return liftMessagingResult("discord", result);
  }

  private async testMattermost(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const botToken = this.deps.resolveMattermostBotToken();
    const serverUrl = this.deps.resolveMattermostServerUrl();
    if (!botToken || !serverUrl) {
      return unset("mattermost", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "mattermost",
      credential: { botToken, serverUrl },
    });
    return liftMessagingResult("mattermost", result);
  }

  private async testSlack(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const botToken = this.deps.resolveSlackBotToken();
    if (!botToken) {
      return unset("slack", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "slack",
      credential: { botToken },
    });
    return liftMessagingResult("slack", result);
  }

  private async testGrok(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const apiKey = await this.deps.resolveGrokApiKey();
    if (!apiKey) {
      return unset("grok", startedAt);
    }
    // The xAI SDK (`@ai-sdk/xai`) we already use in agent-core does
    // NOT expose a non-disruptive smoke-check API — it's a model
    // factory, not a control-plane client. There is no `models.list()`
    // or equivalent. Per the user's clause "use the real library
    // unless the real library does not expose a simple non-disruptive
    // method", a direct `GET /v1/models` is the right call here.
    const { json, status, durationMs } = await this.fetchJson<GrokModelsResponse>({
      url: "https://api.x.ai/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const testedAt = Date.now();
    if (status === 200 && Array.isArray(json?.data)) {
      const ids = json.data
        .map((entry) => entry.id)
        .filter((id): id is string => Boolean(id));
      const detail =
        ids.length === 0
          ? "no models reported"
          : ids.slice(0, 3).join(", ") + (ids.length > 3 ? `, +${ids.length - 3} more` : "");
      return {
        kind: "grok",
        status: "ok",
        testedAt,
        durationMs,
        account: "api.x.ai",
        detail,
      };
    }
    return {
      kind: "grok",
      status: "failed",
      testedAt,
      durationMs,
      errorMessage: clipString(
        json?.error?.message ?? `HTTP ${status} from api.x.ai/v1/models`,
      ),
    };
  }

  private async testCodex(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const command = await this.deps.resolveCodexCommand();
    if (!command) {
      return unset("codex", startedAt);
    }
    const probeStart = Date.now();
    try {
      const { stdout, stderr } = await this.deps.runCodexVersion(command);
      const durationMs = Date.now() - probeStart;
      const testedAt = Date.now();
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
      if (match) {
        return {
          kind: "codex",
          status: "ok",
          testedAt,
          durationMs,
          account: command,
          detail: match[1],
        };
      }
      return {
        kind: "codex",
        status: "failed",
        testedAt,
        durationMs,
        account: command,
        errorMessage: "version banner not recognized in stdout/stderr",
      };
    } catch (error) {
      return {
        kind: "codex",
        status: "failed",
        testedAt: Date.now(),
        durationMs: Date.now() - probeStart,
        account: command,
        errorMessage: clipError(error),
      };
    }
  }

  /**
   * Helper for the Grok probe. Times out via AbortController so the
   * renderer never hangs longer than `timeoutMs`. Parses JSON
   * best-effort; non-JSON responses fall through to a string with
   * status code only.
   */
  private async fetchJson<T>(input: {
    url: string;
    method: "GET";
    headers?: Record<string, string>;
  }): Promise<{ json: T | undefined; status: number; durationMs: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.deps.fetch(input.url, {
        method: input.method,
        headers: input.headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let json: T | undefined;
      try {
        json = text ? (JSON.parse(text) as T) : undefined;
      } catch {
        json = undefined;
      }
      return {
        json,
        status: response.status,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Translate a generic `MessagingCredentialValidationResult` (returned
 * by the messaging runtime / provider) into the IPC-shaped
 * `SettingsCredentialTestResult` the renderer consumes. The shapes
 * differ only in the `kind` field; everything else is preserved.
 */
function liftMessagingResult(
  kind: "telegram" | "discord" | "mattermost" | "slack",
  result: MessagingCredentialValidationResult,
): SettingsCredentialTestResult {
  return {
    kind,
    status: result.status,
    testedAt: result.testedAt,
    durationMs: result.durationMs,
    ...(result.account !== undefined ? { account: result.account } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    ...(result.errorMessage !== undefined
      ? { errorMessage: result.errorMessage }
      : {}),
  };
}

function unset(
  kind: SettingsCredentialTestKind,
  startedAt: number,
): SettingsCredentialTestResult {
  return {
    kind,
    status: "unset" as SettingsCredentialTestStatus,
    testedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };
}

function clipString(value: string): string {
  if (value.length <= ERROR_MESSAGE_LIMIT) return value;
  return `${value.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`;
}

function clipError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timed out";
    return clipString(error.message);
  }
  return clipString(String(error));
}

async function defaultRunCodexVersion(
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, ["--version"], {
    timeout: DEFAULT_PROBE_TIMEOUT_MS,
  });
  return {
    stdout: stdout?.toString?.() ?? "",
    stderr: stderr?.toString?.() ?? "",
  };
}
