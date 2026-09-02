import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGitExecutable } from "../app-server/git-executable";

describe("resolveGitExecutable", () => {
  it("caches an absolute executable instead of a PATH command", async () => {
    const env = { ...process.env };

    const first = await resolveGitExecutable(env);
    const second = await resolveGitExecutable(env);

    expect(path.isAbsolute(first)).toBe(true);
    expect(second).toBe(first);
    expect(path.basename(first).toLowerCase()).toMatch(/^git(?:\.exe)?$/);
  });
});
