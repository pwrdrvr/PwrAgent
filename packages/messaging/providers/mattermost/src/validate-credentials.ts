import {
  clipMessagingValidationError,
  type MattermostCredentialValidationConfig,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";

const PROBE_PATH = "/api/v4/users/me";
const DEFAULT_TIMEOUT_MS = 8_000;

export type MattermostValidateCredentialsOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Smoke-check a Mattermost bot token + server URL by calling
 * `GET <serverUrl>/api/v4/users/me` with `Authorization: Bearer <token>`.
 *
 * Mattermost has no published Node SDK we already depend on, and the
 * REST surface is stable, so a direct fetch is the right call here —
 * matches the pattern used for Grok in `credential-tester.ts`.
 *
 * Both `botToken` and `serverUrl` are required: the URL alone tells us
 * nothing about whether the token is valid, and the token alone has
 * no server to reach. An empty value of either yields `unset`.
 */
export async function validateCredentials(
  config: MattermostCredentialValidationConfig,
  options: MattermostValidateCredentialsOptions = {},
): Promise<MessagingCredentialValidationResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!config.botToken || !config.serverUrl) {
    return {
      status: "unset",
      durationMs: 0,
      testedAt: startedAt,
    };
  }

  const url = buildProbeUrl(config.serverUrl);
  if (!url) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        `Invalid Mattermost server URL: ${config.serverUrl}`,
      ),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await safeReadText(response);
      return {
        status: "failed",
        durationMs: Date.now() - startedAt,
        testedAt: Date.now(),
        errorMessage: clipMessagingValidationError(
          `HTTP ${response.status} ${response.statusText || ""} ${body}`.trim(),
        ),
      };
    }
    const me = (await response.json()) as {
      id?: string;
      username?: string;
    };
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account: me.username ?? me.id ?? "unknown",
      detail: hostFromUrl(config.serverUrl),
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProbeUrl(serverUrl: string): string | undefined {
  try {
    const base = new URL(serverUrl);
    return new URL(PROBE_PATH, base).toString();
  } catch {
    return undefined;
  }
}

function hostFromUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
