import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { buildOwnerFixture } from "../main/__tests__/helpers/built-owner-fixture";
import { createNativeHelperFixture } from "./native-helper-fixture";

type OwnerKind = "desktop" | "headless";
type OwnerPackage = { directory: string; preload: string };

declare module "vitest" {
  export interface ProvidedContext {
    ownerConformanceFixtures: Record<OwnerKind, OwnerPackage>;
  }
}

const suite = fileURLToPath(new URL("../main/__tests__/owner-conformance.test.ts", import.meta.url));

async function buildOwnerPackages(root: string): Promise<Record<OwnerKind, OwnerPackage>> {
  async function buildPackage(kind: OwnerKind): Promise<OwnerPackage> {
    const directory = path.join(root, kind);
    return { directory, preload: await buildOwnerFixture(directory, kind) };
  }

  // Keep both output trees alive until both builders have stopped.
  const [desktop, headless] = await Promise.allSettled([buildPackage("desktop"), buildPackage("headless")]);
  if (desktop.status === "rejected") throw desktop.reason;
  if (headless.status === "rejected") throw headless.reason;
  return { desktop: desktop.value, headless: headless.value };
}

export default async function setup(project: TestProject) {
  if (process.platform === "win32") return;

  let fixtures: ReturnType<typeof createNativeHelperFixture<Record<OwnerKind, OwnerPackage>>> | undefined;
  const dispose = async (): Promise<void> => {
    await fixtures?.dispose();
  };
  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // The pool applies sharding after global setup. Build only for a shard
    // that will run conformance, and keep the packages for watch-mode reruns.
    const selected = project.vitest.config.shard
      ? await new project.vitest.config.sequence.sequencer(project.vitest).shard(specifications)
      : specifications;
    if (!selected.some((spec) => spec.project === project && spec.moduleId === suite)) return;

    fixtures ??= createNativeHelperFixture(buildOwnerPackages);
    project.provide("ownerConformanceFixtures", await fixtures.ready);
  };

  try {
    const specifications = project.vitest.state.getPaths().flatMap((file) => project.vitest.getModuleSpecifications(file));
    await prepare(specifications);
  } catch (error) {
    await dispose();
    throw error;
  }
  project.onTestsRerun(prepare);
  return dispose;
}
