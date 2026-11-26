import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture } from "./native-helper-fixture";

const consumer = fileURLToPath(new URL("../main/__tests__/owner-conformance.test.ts", import.meta.url));
const builder = fileURLToPath(new URL("../main/__tests__/helpers/built-owner-fixture.ts", import.meta.url));
type FixtureBuilder = typeof import("../main/__tests__/helpers/built-owner-fixture");
export type OwnerFixtures = Record<"desktop" | "headless", { directory: string; preload: string }>;
type FixturePreparation = { fixtures: OwnerFixtures } | { error: string };

declare module "vitest" {
  export interface ProvidedContext {
    ownerConformanceFixtures: FixturePreparation;
  }
}

async function buildFixtures(root: string, buildOwnerFixture: FixtureBuilder["buildOwnerFixture"]): Promise<OwnerFixtures> {
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
  const owned: Array<ReturnType<typeof createNativeHelperFixture<OwnerFixtures>>> = [];
  let preparing = Promise.resolve();
  const dispose = async (): Promise<void> => {
    await preparing;
    await Promise.all(owned.map((fixture) => fixture.dispose()));
  };
  if (process.platform === "win32") return dispose; // The suite is skipped on Windows.

  const buildAndPublish = async (): Promise<void> => {
    let result: FixturePreparation;
    try {
      const fixture = createNativeHelperFixture(async (root) => {
        // Vitest's global-setup runner can keep an evaluated builder across
        // watch reruns. Key the import by the rewrite source to see edits.
        const digest = createHash("sha256").update(await readFile(builder)).digest("hex");
        const { buildOwnerFixture } = await project.import<FixtureBuilder>(`${builder}?ownerFixtureSource=${digest}`);
        return await buildFixtures(root, buildOwnerFixture);
      });
      // Overlapping reruns can still be using any earlier context snapshot.
      // Keep the directories for the lifetime of the Vitest project.
      owned.push(fixture);
      result = { fixtures: await fixture.ready };
    } catch (error) {
      // Throwing from onTestsRerun stops Vitest watch. Let the consumer
      // report a suite failure so the next edit can trigger another build.
      result = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
    }
    project.provide("ownerConformanceFixtures", result);
  };

  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // Global setup precedes the pool's shard selection. Use its sequencer so
    // only the lane that runs conformance pays for the builds.
    const { config } = project.vitest;
    const selected = config.shard
      ? await new config.sequence.sequencer(project.vitest).shard([...specifications])
      : specifications;
    if (!selected.some((spec) => spec.project === project && spec.moduleId === consumer)) return;

    // Publish in rerun order so a slower older build cannot replace a newer
    // result, including when either build fails.
    preparing = preparing.then(buildAndPublish);
    await preparing;
  };

  await prepare(project.vitest.state.getPaths().flatMap((file) => project.vitest.getModuleSpecifications(file)));
  project.onTestsRerun(prepare);
  return dispose;
}
