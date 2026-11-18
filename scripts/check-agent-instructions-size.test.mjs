import { describe, expect, it } from "vitest";

import {
  ROOT_AGENTS_MD_MAX_BYTES,
  checkAgentInstructionsSize,
} from "./check-agent-instructions-size.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;

describe("checkAgentInstructionsSize", () => {
  it("keeps the limit under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(
      CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    );
  });

  it("passes exactly the sizes at or under the limit", () => {
    const limit = 100;
    for (let bytes = 0; bytes <= 2 * limit; bytes += 1) {
      const result = checkAgentInstructionsSize(bytes, limit);
      expect(result.ok).toBe(bytes <= limit);
      if (!result.ok) {
        expect(result.message).toContain(`${bytes - limit} over`);
      }
    }
  });

  it("rejects a file Codex would truncate", () => {
    expect(
      checkAgentInstructionsSize(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES + 1).ok,
    ).toBe(false);
  });
});
