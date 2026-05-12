import { describe, expect, it, vi } from "vitest";
import { validateCredentials } from "../validate-credentials.ts";

describe("Feishu validateCredentials", () => {
  it("returns account metadata from tenant token and bot info probes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          code: 0,
          tenant_access_token: "tenant-token",
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          code: 0,
          bot: {
            app_name: "PwrAgent",
            open_id: "ou_bot",
          },
        })),
      );

    await expect(validateCredentials({
      appId: "cli_test",
      appSecret: "secret",
      tenantUrl: "https://open.feishu.cn/",
    }, { fetch })).resolves.toMatchObject({
      status: "ok",
      account: "PwrAgent",
      detail: "ou_bot",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/bot/v3/info",
      expect.objectContaining({
        headers: { authorization: "Bearer tenant-token" },
      }),
    );
  });

  it("trims copied app credentials before sending the token probe", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          code: 0,
          tenant_access_token: "tenant-token",
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          code: 0,
          bot: {
            app_name: "PwrAgent",
          },
        })),
      );

    await expect(validateCredentials({
      appId: " cli_test\n",
      appSecret: " secret\n",
      tenantUrl: " https://open.larksuite.com/ ",
    }, { fetch })).resolves.toMatchObject({
      status: "ok",
      account: "PwrAgent",
      detail: "open.larksuite.com",
    });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({
      app_id: "cli_test",
      app_secret: "secret",
    }));
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://open.larksuite.com/open-apis/bot/v3/info",
    );
  });

  it("returns OpenAPI status, code, and field violations when token validation fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        code: 99991663,
        msg: "field validation failed",
        error: {
          log_id: "202605120001",
          field_violations: [
            { field: "app_id", description: "must start with cli_" },
          ],
        },
      }), { status: 400 }),
    );

    const result = await validateCredentials({
      appId: "bad-app-id",
      appSecret: "secret",
      tenantUrl: "https://open.larksuite.com",
    }, { fetch });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.errorMessage).toContain(
      "Feishu/Lark tenant token probe failed: field validation failed",
    );
    expect(result.errorMessage).toContain("HTTP 400");
    expect(result.errorMessage).toContain("code 99991663");
    expect(result.errorMessage).toContain("log 202605120001");
    expect(result.errorMessage).toContain("app_id: must start with cli_");
  });
});
