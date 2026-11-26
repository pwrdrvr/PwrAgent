import type { BackendAccountSummary } from "@pwragent/shared/contracts/backend";
import {
  parseAccountTokenUsagePayload,
  type AccountTokenUsageObservation,
  type AccountTokenUsageUnavailableReason,
} from "@pwragent/shared/contracts/usage-activity";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { usageAccountKey } from "../usage-account-identity";
import type { BackendClient } from "./backend-registry-types";
import { isUnauthenticatedCodexProvider } from "./thread-model-options";

const DEFAULT_ACCOUNT_USAGE_TIMEOUT_MS = 8_000;

export function classifyAccountTokenUsageError(error: unknown): AccountTokenUsageUnavailableReason {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /authentication required|auth required|unauthenticated|login required|chatgpt.*required|\bsign in\b/i.test(message)
  ) {
    return "auth_required";
  }
  if (
    /-32601|method not found|unknown method|unknown variant|not supported|not implemented|unsupported/i.test(message)
  ) {
    return "unsupported";
  }
  return "unavailable";
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Account token usage read timed out.")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read OpenAI account-wide daily token history through Codex App Server's
 * `account/usage/read` protocol method (never reading Codex-owned files).
 * Scoped to on-demand Usage Activity reads; fails closed into a typed status
 * without failing the surrounding Usage Activity response.
 */
export async function readCodexAccountTokenUsage(params: {
  client: BackendClient;
  openAiProviderEnabled: boolean;
  codexAvailable: boolean;
  cachedAccount?: BackendAccountSummary;
  usageAccountGroup?: string;
  now?: () => number;
  timeoutMs?: number;
}): Promise<AccountTokenUsageObservation | undefined> {
  if (!params.openAiProviderEnabled || !params.codexAvailable || !params.client.readAccountUsage) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  // One budget covers both reads: Usage Activity waits on this call, so a slow
  // App Server must not stack a second full timeout after the account read.
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_ACCOUNT_USAGE_TIMEOUT_MS);
  const remainingMs = () => Math.max(0, deadline - Date.now());

  let account = params.client.readAccount ? undefined : params.cachedAccount;
  if (params.client.readAccount && !params.client.isAuthenticationRequired?.()) {
    try {
      account = await withTimeout(
        withCodexRequestActivity({ countsAsActivity: false }, () => params.client.readAccount!()),
        remainingMs(),
      );
    } catch {
      // Never reuse a cached account identity after a failed account read:
      // the session may have switched accounts or signed out.
      account = undefined;
    }
  }

  const accountKey = usageAccountKey(account, params.usageAccountGroup);
  const planType = account?.planType;
  const base = {
    provider: "openai",
    ...(accountKey ? { accountKey } : {}),
    ...(planType ? { planType } : {}),
  };

  if (
    params.client.isAuthenticationRequired?.()
    || isUnauthenticatedCodexProvider(account)
    || account?.type === "apiKey"
    || (account !== undefined && account.type !== "chatgpt")
  ) {
    return { ...base, observedAt: now(), status: "auth_required" };
  }

  try {
    const raw = await withTimeout(
      withCodexRequestActivity({ countsAsActivity: false }, () => params.client.readAccountUsage!()),
      remainingMs(),
    );
    const parsed = parseAccountTokenUsagePayload(raw);
    if (!parsed) {
      return { ...base, observedAt: now(), status: "unavailable" };
    }
    return {
      ...base,
      observedAt: now(),
      status: "available",
      dailyUsageBuckets: parsed.dailyUsageBuckets,
      ...(parsed.summary ? { summary: parsed.summary } : {}),
    };
  } catch (error) {
    return {
      ...base,
      observedAt: now(),
      status: classifyAccountTokenUsageError(error),
    };
  }
}
