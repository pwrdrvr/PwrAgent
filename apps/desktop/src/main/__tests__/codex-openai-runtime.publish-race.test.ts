import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Another PwrAgent sharing the root publishes the same release between this
// install's destination check and its rename. Only that rename is intercepted.
const race = vi.hoisted(() => ({ destination: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to === race.destination) {
        race.destination = undefined;
        await actual.cp(from, to, { recursive: true });
      }
      return await actual.rename(from, to);
    },
  };
});

const { ensureOpenAiCodexRuntime, readInstalledOpenAiCodexRuntime, resetOpenAiCodexRuntimeChecks } =
  await import("../codex-openai-runtime");
const fixture = await import("./codex-openai-runtime-fixture");

afterEach(() => {
  resetOpenAiCodexRuntimeChecks();
});

it.skipIf(process.platform === "win32")(
  "accepts the copy another PwrAgent published first instead of failing the install",
  async () => {
    await fixture.withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      race.destination = path.join(rootDir, "versions", "0.172.0");
      const archives = new Map([["0.172.0", await fixture.makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      const installed = await ensureOpenAiCodexRuntime({
        ...fixture.appleSilicon, rootDir, checkMode: "force",
        fetch: fixture.openAiReleaseFetch({ latest: () => "0.172.0", archives }),
        probeVersion: fixture.probeFixtureVersion, progress: fixture.recordingProgress(),
      });
      expect(race.destination).toBeUndefined();
      expect(installed?.version).toBe("0.172.0");
      expect((await readInstalledOpenAiCodexRuntime({ ...fixture.appleSilicon, rootDir }))?.version).toBe("0.172.0");
    });
  },
);
