import {
  clipMessagingValidationError,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";
import type { FeishuTenantRegion } from "./feishu-config.ts";

export type FeishuCredentialValidationConfig = {
  appId: string;
  appSecret: string;
  tenantRegion?: FeishuTenantRegion;
  tenantUrl: string;
};

export type FeishuValidateCredentialsOptions = {
  fetch?: typeof fetch;
};

export async function validateCredentials(
  config: FeishuCredentialValidationConfig,
  options: FeishuValidateCredentialsOptions = {},
): Promise<MessagingCredentialValidationResult> {
  const startedAt = Date.now();
  const appId = config.appId.trim();
  const appSecret = config.appSecret.trim();
  const tenantUrl = config.tenantUrl.trim();
  if (!appId || !appSecret || !tenantUrl) {
    return {
      status: "unset",
      durationMs: 0,
      testedAt: startedAt,
    };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const baseUrl = normalizeTenantUrl(tenantUrl);
    const tokenUrl = `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
    const tokenResponse = await fetchImpl(
      tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret,
        }),
      },
    );
    const tokenBody = await readResponseJson<{
      code?: number;
      error?: FeishuOpenApiError;
      msg?: string;
      tenant_access_token?: string;
    }>(tokenResponse);
    if (
      !tokenResponse.ok
      || tokenBody.payload?.code !== 0
      || !tokenBody.payload.tenant_access_token
    ) {
      throw new Error(formatFeishuApiError({
        body: tokenBody.text,
        endpoint: tokenUrl,
        payload: tokenBody.payload,
        response: tokenResponse,
        stage: "tenant token",
      }));
    }

    const selfUrl = `${baseUrl}/open-apis/application/v6/applications/self`;
    const selfResponse = await fetchImpl(
      selfUrl,
      {
        headers: {
          authorization: `Bearer ${tokenBody.payload.tenant_access_token}`,
        },
      },
    );
    const selfBody = await readResponseJson<{
      code?: number;
      data?: {
        app?: { app_name?: string };
        bot?: { open_id?: string };
        tenant_key?: string;
      };
      error?: FeishuOpenApiError;
      msg?: string;
    }>(selfResponse);
    if (!selfResponse.ok || selfBody.payload?.code !== 0) {
      throw new Error(formatFeishuApiError({
        body: selfBody.text,
        endpoint: selfUrl,
        payload: selfBody.payload,
        response: selfResponse,
        stage: "app self",
      }));
    }

    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account: selfBody.payload.data?.app?.app_name ?? selfBody.payload.data?.bot?.open_id ?? appId,
      detail: selfBody.payload.data?.tenant_key ?? hostFromUrl(tenantUrl),
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
  }
}

type FeishuOpenApiError = {
  field_violations?: Array<{
    description?: string;
    field?: string;
    value?: unknown;
  }>;
  log_id?: string;
  message?: string;
};

type FeishuApiPayload = {
  code?: number;
  error?: FeishuOpenApiError;
  msg?: string;
};

async function readResponseJson<T>(response: Response): Promise<{
  payload: T | undefined;
  text: string;
}> {
  const text = await response.text();
  if (!text) {
    return { payload: undefined, text };
  }
  try {
    return { payload: JSON.parse(text) as T, text };
  } catch {
    return { payload: undefined, text };
  }
}

function formatFeishuApiError(params: {
  body: string;
  endpoint: string;
  payload: FeishuApiPayload | undefined;
  response: Response;
  stage: string;
}): string {
  const host = hostFromUrl(params.endpoint);
  const message =
    params.payload?.error?.message
    ?? params.payload?.msg
    ?? (params.payload ? undefined : clipBody(params.body))
    ?? `HTTP ${params.response.status}`;
  const details = [
    `HTTP ${params.response.status}`,
    typeof params.payload?.code === "number" ? `code ${params.payload.code}` : undefined,
    params.payload?.error?.log_id ? `log ${params.payload.error.log_id}` : undefined,
    host,
    formatFieldViolations(params.payload?.error?.field_violations),
  ].filter((detail): detail is string => Boolean(detail));
  return `Feishu/Lark ${params.stage} probe failed: ${message}${
    details.length ? ` (${details.join("; ")})` : ""
  }`;
}

function formatFieldViolations(
  violations: FeishuOpenApiError["field_violations"] | undefined,
): string | undefined {
  if (!violations?.length) return undefined;
  const fields = violations
    .slice(0, 3)
    .map((violation) => {
      const field = violation.field ?? "field";
      return violation.description ? `${field}: ${violation.description}` : field;
    });
  return `fields ${fields.join(", ")}`;
}

function clipBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

function normalizeTenantUrl(url: string): string {
  const parsed = new URL(url);
  const canonical = parsed.toString();
  return canonical.endsWith("/") ? canonical.slice(0, -1) : canonical;
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
