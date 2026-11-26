import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type ProvidedContext } from "vitest";
import type { TestProject, TestSpecification } from "vitest/node";
import setup from "../../test-setup/owner-conformance-fixtures";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

vi.mock("./helpers/built-owner-fixture", () => ({ buildOwnerFixture: vi.fn() }));

function watchProject() {
  const provide = vi.fn<(key: string, value: ProvidedContext["ownerConformanceFixtures"]) => void>();
  const onTestsRerun = vi.fn<(prepare: (specs: TestSpecification[]) => Promise<void>) => void>();
  const moduleId = path.join(import.meta.dirname, "owner-conformance.test.ts");
  const project = {
    import: async () => ({ buildOwnerFixture }),
    vitest: {
      config: { watch: true },
      state: { getPaths: () => [moduleId] },
      getModuleSpecifications: (id: string) => [{ moduleId: id, project }],
    },
    provide,
    onTestsRerun,
  } as unknown as TestProject;
  const rerun = (id = moduleId) => onTestsRerun.mock.calls[0]![0](project.vitest.getModuleSpecifications(id));
  return { project, provide, rerun };
}

function writePreload(directory: string): string {
  const preload = path.join(directory, "guard.cjs");
  mkdirSync(directory);
  writeFileSync(preload, "");
  return preload;
}

describe.skipIf(process.platform === "win32")("owner conformance fixture watch mode", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(buildOwnerFixture).mockReset().mockImplementation(async (directory) => writePreload(directory));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("publishes two freshly built packages only when a watch rerun selects conformance", async () => {
    let revision = "original";
    vi.mocked(buildOwnerFixture).mockImplementation(async (directory) => path.join(directory, revision));
    const { project, provide, rerun } = watchProject();
    const dispose = await setup(project);
    try {
      const original = provide.mock.lastCall![1];
      revision = "edited";
      await rerun(path.join(import.meta.dirname, "unrelated.test.ts"));
      expect(provide).toHaveBeenCalledOnce();
      expect(buildOwnerFixture).toHaveBeenCalledTimes(2);

      await rerun();
      const updated = provide.mock.lastCall![1];
      expect(buildOwnerFixture).toHaveBeenCalledTimes(4);
      if ("error" in original || "error" in updated) throw new Error("Expected fixtures for both revisions");
      for (const kind of ["desktop", "headless"] as const) {
        expect(path.basename(updated.fixtures[kind].preload)).toBe(revision);
        expect(updated.fixtures[kind].directory).not.toBe(original.fixtures[kind].directory);
      }
    } finally {
      await dispose();
    }
  });

  it("keeps published files readable across a second rerun queued during a build", async () => {
    const { project, provide, rerun } = watchProject();
    const dispose = await setup(project);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(buildOwnerFixture).mockImplementationOnce(async (directory) => {
      entered.resolve();
      await release.promise;
      return writePreload(directory);
    });

    let guards: string[] = [];
    try {
      const first = rerun();
      await entered.promise;
      const second = rerun();
      release.resolve();
      await Promise.all([first, second]);

      // Vitest can capture provided paths before a later rerun publishes its
      // replacements. Each captured pair is readable for those workers.
      expect(provide).toHaveBeenCalledTimes(3);
      guards = vi.mocked(buildOwnerFixture).mock.calls.map(([directory]) => path.join(directory, "guard.cjs"));
      expect(guards).toHaveLength(6);
      expect(guards.every(existsSync)).toBe(true);
    } finally {
      release.resolve();
      await dispose();
    }
    expect(guards.some(existsSync)).toBe(false);
  });

  it("reports a broken rewrite to the suite and can prepare again on the next save", async () => {
    const { project, provide, rerun } = watchProject();
    const dispose = await setup(project);
    try {
      vi.mocked(buildOwnerFixture).mockRejectedValueOnce(new Error("fixture rewrite no longer matches"));
      await expect(rerun()).resolves.toBeUndefined();
      expect(provide).toHaveBeenLastCalledWith("ownerConformanceFixtures", {
        error: expect.stringContaining("fixture rewrite no longer matches"),
      });

      await rerun();
      expect(provide).toHaveBeenLastCalledWith("ownerConformanceFixtures", {
        fixtures: { desktop: expect.any(Object), headless: expect.any(Object) },
      });
    } finally {
      await dispose();
    }
  });
});
