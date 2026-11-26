import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture } from "./native-helper-fixture";

const consumer = fileURLToPath(new URL("../main/__tests__/owner-conformance.test.ts", import.meta.url));
type OwnerFixtures = Record<"desktop" | "headless", { directory: string; preload: string }>;

declare module "vitest" {
  export interface ProvidedContext {
    ownerConformanceFixtures: OwnerFixtures;
  }
}

async function buildFixtures(root: string): Promise<OwnerFixtures> {
  const { buildOwnerFixture } = await import("../main/__tests__/helpers/built-owner-fixture");
  const build = async (kind: keyof OwnerFixtures) => {
    const directory = path.join(root, kind);
    const started = performance.now();
    try {
      const preload = await buildOwnerFixture(directory, kind);
      return { directory, preload };
    } finally {
      console.info(`[owner-conformance-fixtures] ${kind} build took ${Math.round(performance.now() - started)} ms`);
    }
  };
  // Both builds must stop writing before a failed setup can remove the root.
  const [desktop, headless] = await Promise.allSettled([build("desktop"), build("headless")]);
  if (desktop.status === "rejected") throw desktop.reason;
  if (headless.status === "rejected") throw headless.reason;
  return { desktop: desktop.value, headless: headless.value };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let fixtures: ReturnType<typeof createNativeHelperFixture<OwnerFixtures>> | undefined;
  const dispose = async (): Promise<void> => { await fixtures?.dispose(); };
  if (process.platform === "win32") return dispose; // The suite is skipped on Windows.

  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // Global setup precedes the pool's shard selection. Use its sequencer so
    // only the lane that runs conformance pays for the builds.
    const { config } = project.vitest;
    const selected = config.shard
      ? await new config.sequence.sequencer(project.vitest).shard([...specifications])
      : specifications;
    if (!selected.some((spec) => spec.project === project && spec.moduleId === consumer)) return;

    await dispose();
    fixtures = createNativeHelperFixture(buildFixtures);
    try {
      project.provide("ownerConformanceFixtures", await fixtures.ready);
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  await prepare(project.vitest.state.getPaths().flatMap((file) => project.vitest.getModuleSpecifications(file)));
  project.onTestsRerun(prepare);
  return dispose;
}
