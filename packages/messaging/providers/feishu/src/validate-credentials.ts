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
  if (!config.appId || !config.appSecret || !config.tenantUrl) {
    return {
      status: "unset",
      durationMs: 0,
      testedAt: startedAt,
    };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const baseUrl = normalizeTenantUrl(config.tenantUrl);
    const tokenResponse = await fetchImpl(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
      },
    );
    const tokenPayload = await tokenResponse.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    };
    if (
      !tokenResponse.ok
      || tokenPayload.code !== 0
      || !tokenPayload.tenant_access_token
    ) {
      throw new Error(tokenPayload.msg || `Feishu token probe failed: ${tokenResponse.status}`);
    }

    const selfResponse = await fetchImpl(
      `${baseUrl}/open-apis/application/v6/applications/self`,
      {
        headers: {
          authorization: `Bearer ${tokenPayload.tenant_access_token}`,
        },
      },
    );
    const selfPayload = await selfResponse.json() as {
      code?: number;
      data?: {
        app?: { app_name?: string };
        bot?: { open_id?: string };
        tenant_key?: string;
      };
      msg?: string;
    };
    if (!selfResponse.ok || selfPayload.code !== 0) {
      throw new Error(selfPayload.msg || `Feishu app probe failed: ${selfResponse.status}`);
    }

    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account: selfPayload.data?.app?.app_name ?? selfPayload.data?.bot?.open_id ?? config.appId,
      detail: selfPayload.data?.tenant_key ?? hostFromUrl(config.tenantUrl),
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
