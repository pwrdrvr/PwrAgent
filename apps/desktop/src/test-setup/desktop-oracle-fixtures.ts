import path from "node:path";
import type { TestProject, TestSpecification } from "vitest/node";
import type { buildHeadlessDriverFixture } from "../main/__tests__/helpers/headless-driver-fixture";
import { createNativeHelperFixture } from "./native-helper-fixture";
import type { OracleFixture } from "./oracle-fixture-context";

async function prepareFixture<T>(label: string, buildFixture: () => Promise<T>): Promise<OracleFixture<T>> {
  const started = performance.now();
  try {
    return { value: await buildFixture() };
  } catch (error) {
    // Surface the failure in its consumer and allow watch to try new source.
    return { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  } finally {
    console.info(`[desktop-oracle-fixtures] ${label} took ${Math.round(performance.now() - started)} ms`);
  }
}

type HeadlessDriver = Awaited<ReturnType<typeof buildHeadlessDriverFixture>>;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const drivers: Array<ReturnType<typeof createNativeHelperFixture<HeadlessDriver>>> = [];
  let preparing = Promise.resolve();
  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // Global setup runs before the pool applies its configured shard.
    const { config } = project.vitest;
    const selected = config.shard
      ? await new config.sequence.sequencer(project.vitest).shard([...specifications])
      : specifications;
    const files = new Set(selected.filter((spec) => spec.project === project).map((spec) => path.basename(spec.moduleId)));
    preparing = preparing.then(async () => {
      if (files.has("headless-concurrency.oracle.test.ts") || files.has("headless-host.boot.oracle.test.ts")) {
        // Retain earlier watch outputs until all workers have retired.
        const driver = createNativeHelperFixture(async (root) => {
          const { buildHeadlessDriverFixture } = await import("../main/__tests__/helpers/headless-driver-fixture");
          return buildHeadlessDriverFixture(root);
        });
        drivers.push(driver);
        project.provide("headlessDriver", await prepareFixture("headless driver", () => driver.ready));
      }
      if (files.has("production-entry-host.oracle.test.ts")) {
        project.provide("desktopEntryHasFileKey", await prepareFixture("desktop entry", async () => {
          const { desktopEntryHasFileKey } = await import("../main/__tests__/helpers/production-entry-bundle");
          return desktopEntryHasFileKey();
        }));
      }
    });
    await preparing;
  };
  await prepare(project.vitest.state.getPaths().flatMap((file) => project.vitest.getModuleSpecifications(file)));
  project.onTestsRerun(prepare);
  return async () => {
    await preparing;
    await Promise.all(drivers.map((driver) => driver.dispose()));
  };
}
