import { describe, expect, it, vi } from "vitest";
import { validateCredentials } from "../validate-credentials.ts";

describe("Feishu validateCredentials", () => {
  it("returns account metadata from tenant token and self probes", async () => {
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
          data: {
            app: { app_name: "PwrAgent" },
            bot: { open_id: "ou_bot" },
            tenant_key: "tenant_1",
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
      detail: "tenant_1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
