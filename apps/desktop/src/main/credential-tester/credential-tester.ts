import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MessagingCredentialValidationResult } from "@pwragent/messaging-interface";
import type {
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
  SettingsCredentialTestStatus,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getMainLogger } from "../log";
import type { CredentialValidationRequest } from "../messaging/messaging-runtime";
import {
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
} from "@pwrdrvr/codex-discovery";
import { createCodexCommandInvocation } from "../codex-powershell";

const execFileAsync = promisify(execFile);

const log = getMainLogger("pwragent:credential-tester");

/**
 * Default per-probe timeout. The Codex subprocess is bounded here.
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
  resolveFeishuAppId: () => string | undefined;
  resolveFeishuAppSecret: () => string | undefined;
  resolveFeishuTenantUrl: () => string | undefined;
  resolveLineChannelAccessToken: () => string | undefined;
  /** Returns the configured Mattermost server URL (settings/env merged).
   *  Used together with the bot token to target the `users/me` probe. */
  resolveMattermostServerUrl: () => string | undefined;
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
  /** Override the codex `--version` runner. Defaults to spawning the binary. */
  runCodexVersion?: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override the probe timeout (ms). Applied to the Codex subprocess;
   *  messaging probes use their library's own timeout. */
  timeoutMs?: number;
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
 * - **Codex**: spawn `<resolved-path> --version`. There's no library
 *   to use; Codex is a binary.
 */
export class CredentialTester {
  private readonly deps: Required<
    Omit<
      CredentialTesterDependencies,
      "runCodexVersion" | "timeoutMs"
    >
  > & {
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
      resolveFeishuAppId: dependencies.resolveFeishuAppId,
      resolveFeishuAppSecret: dependencies.resolveFeishuAppSecret,
      resolveFeishuTenantUrl: dependencies.resolveFeishuTenantUrl,
      resolveLineChannelAccessToken: dependencies.resolveLineChannelAccessToken,
      resolveMattermostServerUrl: dependencies.resolveMattermostServerUrl,
      resolveCodexCommand: dependencies.resolveCodexCommand,
      validateMessagingCredentials: dependencies.validateMessagingCredentials,
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
    log.info("credential test started", { kind });
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
    const logData = {
      kind,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.account ? { account: result.account } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
    if (result.status === "failed") {
      log.warn("credential test failed", logData);
    } else {
      log.info("credential test completed", logData);
    }
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
      case "codex":
        return await this.testCodex(startedAt);
      case "mattermost":
        return await this.testMattermost(startedAt);
      case "slack":
        return await this.testSlack(startedAt);
      case "feishu":
        return await this.testFeishu(startedAt);
      case "line":
        return await this.testLine(startedAt);
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

  private async testFeishu(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const appId = this.deps.resolveFeishuAppId();
    const appSecret = this.deps.resolveFeishuAppSecret();
    const tenantUrl = this.deps.resolveFeishuTenantUrl();
    if (!appId || !appSecret || !tenantUrl) {
      return unset("feishu", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "feishu",
      credential: { appId, appSecret, tenantUrl },
    });
    return liftMessagingResult("feishu", result);
  }

  private async testLine(
    startedAt: number,
  ): Promise<SettingsCredentialTestResult> {
    const channelAccessToken = this.deps.resolveLineChannelAccessToken();
    if (!channelAccessToken) {
      return unset("line", startedAt);
    }
    const result = await this.deps.validateMessagingCredentials({
      channel: "line",
      credential: { channelAccessToken },
    });
    return liftMessagingResult("line", result);
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
        const version = match[1];
        if (compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) {
          return {
            kind: "codex",
            status: "failed",
            testedAt,
            durationMs,
            account: command,
            errorMessage: `Codex CLI ${version} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}`,
          };
        }
        return {
          kind: "codex",
          status: "ok",
          testedAt,
          durationMs,
          account: command,
          detail: version,
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

}

/**
 * Translate a generic `MessagingCredentialValidationResult` (returned
 * by the messaging runtime / provider) into the IPC-shaped
 * `SettingsCredentialTestResult` the renderer consumes. The shapes
 * differ only in the `kind` field; everything else is preserved.
 */
function liftMessagingResult(
  kind: "telegram" | "discord" | "mattermost" | "slack" | "feishu" | "line",
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
  const env = buildPwrAgentChildProcessEnv(process.env);
  const invocation = createCodexCommandInvocation({
    command,
    args: ["--version"],
    env,
  });
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    {
      env,
      timeout: DEFAULT_PROBE_TIMEOUT_MS,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  );
  return {
    stdout: stdout?.toString?.() ?? "",
    stderr: stderr?.toString?.() ?? "",
  };
}
