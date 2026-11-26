import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, type ProvidedContext } from "vitest";
import type { TestProject, TestSpecification } from "vitest/node";
import setup from "../../test-setup/owner-conformance-fixtures";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

vi.mock("./helpers/built-owner-fixture", () => ({ buildOwnerFixture: vi.fn() }));

const suite = path.join(import.meta.dirname, "owner-conformance.test.ts");
type Packages = ProvidedContext["ownerConformanceFixtures"];

function projectFixture() {
  const provide = vi.fn<(key: string, packages: Packages) => void>();
  const onTestsRerun = vi.fn<(prepare: (specifications: TestSpecification[]) => Promise<void>) => void>();
  const waitForTestRunEnd = vi.fn(async () => {});
  const project = {
    vitest: {
      config: {},
      state: { getPaths: () => [suite] },
      getModuleSpecifications: (moduleId: string) => [{ moduleId, project }],
      waitForTestRunEnd,
    },
    provide,
    onTestsRerun,
  } as unknown as TestProject;
  return {
    project,
    packages: () => provide.mock.lastCall![1],
    rerun: (moduleId: string) => onTestsRerun.mock.lastCall![0](project.vitest.getModuleSpecifications(moduleId)),
    waitForTestRunEnd,
  };
}

describe.skipIf(process.platform === "win32")("owner conformance fixture preparation", () => {
  // The source revision is the oracle. Both hosts must be built from the
  // revision current when their suite is selected, even in an existing watch.
  it("publishes two newly built packages on a selected watch rerun", async () => {
    let revision = "original";
    vi.mocked(buildOwnerFixture).mockImplementation(async (directory) => path.join(directory, revision));
    const fixture = projectFixture();
    const dispose = await setup(fixture.project);
    try {
      const original = fixture.packages();

      revision = "edited";
      await fixture.rerun(path.join(import.meta.dirname, "unrelated.test.ts"));
      expect(fixture.packages()).toBe(original);

      fixture.waitForTestRunEnd.mockImplementationOnce(async () => {
        expect(fixture.packages()).toBe(original);
        expect(existsSync(path.dirname(original.desktop.directory))).toBe(true);
      });
      await fixture.rerun(suite);
      const edited = fixture.packages();
      for (const kind of ["desktop", "headless"] as const) {
        expect(path.basename(edited[kind].preload)).toBe(revision);
        expect(edited[kind].directory).not.toBe(original[kind].directory);
      }
      expect(fixture.waitForTestRunEnd).toHaveBeenCalledOnce();
      expect(existsSync(path.dirname(original.desktop.directory))).toBe(false);
      expect(existsSync(path.dirname(edited.desktop.directory))).toBe(true);
    } finally {
      await dispose?.();
    }
    expect(existsSync(path.dirname(fixture.packages().desktop.directory))).toBe(false);
  });

  it("aborts a rerun with an incomplete build and can rebuild on a later edit", async () => {
    const build = vi.mocked(buildOwnerFixture);
    build.mockImplementation(async (directory) => path.join(directory, "guard.cjs"));
    const fixture = projectFixture();
    const dispose = await setup(fixture.project);
    try {
      const original = fixture.packages();
      const failure = new Error("controlled owner build failure");
      let failedRoot: string | undefined;
      build.mockImplementationOnce(async (directory) => {
        failedRoot = path.dirname(directory);
        throw failure;
      });

      await expect(fixture.rerun(suite)).rejects.toBe(failure);
      expect(fixture.packages()).toBe(original);
      expect(failedRoot).toBeDefined();
      expect(existsSync(failedRoot!)).toBe(false);

      await fixture.rerun(suite);
      expect(fixture.packages().desktop.directory).not.toBe(original.desktop.directory);
    } finally {
      await dispose?.();
    }
  });
});
