import { describe, expect, it } from "vitest";
import { checkAcpPrerequisite } from "../acp/acp-prerequisites";

describe("checkAcpPrerequisite", () => {
  it("reports an available package manager with parsed version", async () => {
    await expect(
      checkAcpPrerequisite("npx", {
        probe: async () => ({ stdout: "10.9.4\n" }),
      }),
    ).resolves.toEqual({
      name: "npx",
      available: true,
      command: "npx",
      version: "10.9.4",
    });
  });

  it("reports missing package manager as unavailable", async () => {
    const error = new Error("not found") as Error & { code: string };
    error.code = "ENOENT";

    await expect(
      checkAcpPrerequisite("uvx", {
        probe: async () => {
          throw error;
        },
      }),
    ).resolves.toEqual({
      name: "uvx",
      available: false,
      command: "uvx",
      unavailableReason: "not-found",
    });
  });
});
