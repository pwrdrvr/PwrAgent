import path from "node:path";
import fs from "node:fs";
import fc from "fast-check";
import { expect, it, vi } from "vitest";

it("the Outpost fixture belongs to this checkout regardless of its caller's working directory", async () => {
  const expected = path.resolve(import.meta.dirname, "../../../../../packages/pwragent");
  await fc.assert(fc.asyncProperty(fc.constantFrom(expected, path.resolve(expected, "../../apps/desktop"), "/tmp"), async cwd => {
    vi.resetModules();
    const current = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { OUTPOST_PACKAGE_ROOT } = await import("./helpers/outpost-daemon");
      expect(OUTPOST_PACKAGE_ROOT).toBe(expected);
      expect(fs.existsSync(path.join(OUTPOST_PACKAGE_ROOT, "test/fixtures/codex.js"))).toBe(true);
    } finally { current.mockRestore(); }
  }), { numRuns: 3 });
});
