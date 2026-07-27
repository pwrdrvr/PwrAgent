import { describe, expect, it, vi } from "vitest";
import { loadXaiLiveEnv } from "./op-run.mjs";

describe("op-run xAI live environment", () => {
  it("maps the configured 1Password credential into the live-test environment", () => {
    const readSecret = vi.fn(() => "test-xai-key");
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const env = loadXaiLiveEnv(
        {
          GROK_MODEL: "test-model",
          PWRAGENT_XAI_OP_ACCOUNT: "family-account",
          PWRAGENT_XAI_OP_FIELD: "api-key",
          PWRAGENT_XAI_OP_ITEM: "test-item",
          PWRAGENT_XAI_OP_VAULT: "test-vault",
        },
        readSecret,
      );

      expect(readSecret).toHaveBeenCalledWith(
        "op://test-vault/test-item/api-key",
        "family-account",
      );
      expect(env).toMatchObject({
        GROK_MODEL: "test-model",
        XAI_API_KEY: "test-xai-key",
        XAI_BASE_URL: "https://api.x.ai/v1",
      });
      expect(stderrWrite).not.toHaveBeenCalledWith(
        expect.stringContaining("test-xai-key"),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("fails without exposing a missing credential value", () => {
    expect(() =>
      loadXaiLiveEnv(
        {
          PWRAGENT_XAI_OP_ITEM: "test-item",
          PWRAGENT_XAI_OP_VAULT: "test-vault",
        },
        () => undefined,
      ),
    ).toThrow(
      'Failed to load XAI_API_KEY from "test-item" in vault "test-vault".',
    );
  });
});
