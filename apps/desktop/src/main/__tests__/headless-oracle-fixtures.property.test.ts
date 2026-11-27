import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi, type ProvidedContext } from "vitest";
import type { TestProject, TestSpecification } from "vitest/node";
import setup from "../../test-setup/desktop-oracle-fixtures";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { buildHeadlessDriverFixture } from "./helpers/headless-driver-fixture";

vi.mock("../../../scripts/build-headless.mjs", async () => ({ buildHeadless: vi.fn(async ({ outputDirectory }) => { await mkdir(outputDirectory); }) }));
vi.mock("./helpers/headless-driver-fixture", () => ({
  buildHeadlessDriverFixture: vi.fn(async (root: string) => ({ root, outputDirectory: root, guard: "" })),
}));

function watchProject(moduleIds: string[]) {
  const paths: Partial<ProvidedContext> = {};
  const onTestsRerun = vi.fn<(prepare: (specs: TestSpecification[]) => Promise<void>) => void>();
  const waitForTestRunEnd = vi.fn(async () => {});
  const project = {
    import: async () => ({ buildHeadless }),
    vitest: {
      config: { watch: true },
      state: { getPaths: () => moduleIds },
      getModuleSpecifications: (moduleId: string) => [{ moduleId, project }],
      waitForTestRunEnd,
    },
    provide: <Key extends keyof ProvidedContext>(key: Key, value: ProvidedContext[Key]) => { paths[key] = value; },
    onTestsRerun,
  } as unknown as TestProject;
  return {
    paths, waitForTestRunEnd,
    rerun: () => onTestsRerun.mock.calls[0]![0](moduleIds.flatMap(id => project.vitest.getModuleSpecifications(id))),
    project,
  };
}

function fixtureRoot(value: ProvidedContext["headlessDriver"] | undefined) {
  if (!value || "error" in value) throw new Error("Expected a prepared concurrency fixture");
  return value.value.outputDirectory;
}

it("selects the same fixture with either Node or Vitest path separators", async () => {
  const files = ["headless-concurrency.oracle.test.ts", "headless-portable-chunks.oracle.test.ts"];
  const previous = vi.mocked(buildHeadlessDriverFixture).mock.calls.length;
  // Exercise both representations even on a POSIX host.
  for (const separator of ["/", "\\"]) {
    const moduleIds = files.map(file => path.join(import.meta.dirname, file).replace(/[\\/]/g, () => separator));
    const { project, paths, rerun } = watchProject(moduleIds);
    const dispose = await setup(project);
    try {
      expect(existsSync(fixtureRoot(paths.headlessDriver))).toBe(true);
      const sharedPortable = paths.portableOutpost;
      await rerun();
      const portable = paths.portableOutpost;
      if (!portable || "error" in portable) throw new Error("Expected a prepared portable fixture");
      expect(portable).not.toEqual(sharedPortable);
      expect(existsSync(portable.value.directory)).toBe(true);
    } finally { await dispose(); }
  }
  expect(buildHeadlessDriverFixture).toHaveBeenCalledTimes(previous + 4);
});

it("keeps a fixture until its workers drain, then retires the superseded root", async () => {
  const { project, paths, rerun, waitForTestRunEnd } = watchProject([
    path.join(import.meta.dirname, "headless-concurrency.oracle.test.ts"),
  ]);
  const dispose = await setup(project);
  const drained = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  waitForTestRunEnd.mockImplementation(async () => {
    waiting.resolve();
    await drained.promise;
  });
  const first = fixtureRoot(paths.headlessDriver);
  const next = Promise.resolve(rerun());
  try {
    expect(await Promise.race([waiting.promise.then(() => "waiting"), next.then(() => "published")])).toBe("waiting");
    expect(existsSync(first)).toBe(true);
  } finally {
    drained.resolve();
    await next;
    try {
      const current = fixtureRoot(paths.headlessDriver);
      expect(current).not.toBe(first);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(current)).toBe(true);
    } finally { await dispose(); }
  }
});
