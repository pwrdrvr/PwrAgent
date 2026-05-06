import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
  SettingsCredentialTestStatus,
} from "@pwragent/shared";
import { getMainLogger } from "../log";

const execFileAsync = promisify(execFile);

const log = getMainLogger("pwragent:credential-tester");

/**
 * Default per-probe timeout. Subprocess (codex) and HTTP probes both
 * cap here so the renderer never hangs on a `Testing…` pill while the
 * main process waits indefinitely for an unreachable server.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Cap on stored error messages — never surface a giant stack to the renderer. */
const ERROR_MESSAGE_LIMIT = 240;

/**
 * Each probe needs only a tiny slice of the settings service: the
 * resolved secret (or path), and the codex-discovery snapshot for
 * the codex probe. Pulled in via this interface so tests can stub
 * each piece independently.
 */
export interface CredentialTesterDependencies {
  resolveTelegramBotToken: () => string | undefined;
  resolveDiscordBotToken: () => string | undefined;
  resolveGrokApiKey: () => Promise<string | undefined>;
  resolveCodexCommand: () => Promise<string | undefined>;
  /** Override `fetch` for testing. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Override the codex `--version` runner. Defaults to spawning the binary. */
  runCodexVersion?: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override the probe timeout (ms). */
  timeoutMs?: number;
}

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
  };
  description?: string;
  error_code?: number;
}

interface DiscordUsersAtMeResponse {
  id?: string;
  username?: string;
  discriminator?: string;
  message?: string;
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
 */
export class CredentialTester {
  private readonly deps: Required<
    Omit<CredentialTesterDependencies, "fetch" | "runCodexVersion" | "timeoutMs">
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
      resolveGrokApiKey: dependencies.resolveGrokApiKey,
      resolveCodexCommand: dependencies.resolveCodexCommand,
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
      default: {
        const exhaustive: never = kind;
        throw new Error(`unknown credential test kind: ${exhaustive as string}`);
      }
    }
  }

  private async testTelegram(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const token = this.deps.resolveTelegramBotToken();
    if (!token) {
      return unset("telegram", startedAt);
    }
    // Bot tokens MUST go in the URL path per the Telegram contract,
    // not as a header. The full URL stays inside the main process —
    // it never reaches the renderer.
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;
    const { json, status, durationMs } = await this.fetchJson<TelegramGetMeResponse>({
      url,
      method: "GET",
    });
    const testedAt = Date.now();
    if (status === 200 && json?.ok && json.result?.username) {
      return {
        kind: "telegram",
        status: "ok",
        testedAt,
        durationMs,
        account: `@${json.result.username}`,
        detail: "api.telegram.org",
      };
    }
    return {
      kind: "telegram",
      status: "failed",
      testedAt,
      durationMs,
      errorMessage: clipString(
        json?.description
          ?? `HTTP ${status} from api.telegram.org/getMe`,
      ),
    };
  }

  private async testDiscord(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const token = this.deps.resolveDiscordBotToken();
    if (!token) {
      return unset("discord", startedAt);
    }
    const { json, status, durationMs } = await this.fetchJson<DiscordUsersAtMeResponse>({
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
    });
    const testedAt = Date.now();
    if (status === 200 && json?.username) {
      // Discord moved away from the legacy username#discriminator
      // format in 2023; modern users return discriminator "0".
      const account =
        json.discriminator && json.discriminator !== "0"
          ? `${json.username}#${json.discriminator}`
          : json.username;
      return {
        kind: "discord",
        status: "ok",
        testedAt,
        durationMs,
        account,
        detail: "discord.com/api/v10",
      };
    }
    return {
      kind: "discord",
      status: "failed",
      testedAt,
      durationMs,
      errorMessage: clipString(
        json?.message ?? `HTTP ${status} from discord.com/users/@me`,
      ),
    };
  }

  private async testGrok(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const apiKey = await this.deps.resolveGrokApiKey();
    if (!apiKey) {
      return unset("grok", startedAt);
    }
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
   * Single helper for all three HTTP probes. Times out via
   * AbortController so the renderer never hangs longer than
   * `timeoutMs`. Parses JSON best-effort; non-JSON responses fall
   * through to a string with status code only.
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
