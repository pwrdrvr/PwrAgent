import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture } from "./native-helper-fixture";
import type { OracleFixture, PortableOutpostFixture } from "./oracle-fixture-context";

const headlessBuilder = fileURLToPath(new URL("../../scripts/build-headless.mjs", import.meta.url));
const outpostManifest = fileURLToPath(new URL("../../../../packages/pwragent/package.json", import.meta.url));
type HeadlessBuilder = typeof import("../../scripts/build-headless.mjs");

async function buildPortableOutpostFixture(root: string, buildHeadless: HeadlessBuilder["buildHeadless"]): Promise<PortableOutpostFixture> {
  const directory = path.join(root, "dist");
  const resolvePackage = createRequire(outpostManifest);
  const { dependencies } = JSON.parse(await readFile(outpostManifest, "utf8"));
  const externalTargets: Record<string, string> = {};
  // A junction to the entire pnpm node_modules tree cannot resolve from the
  // temporary install on Windows. Only link the declared runtime externals.
  for (const name of Object.keys(dependencies)) {
    const manifest = resolvePackage.resolve(`${name}/package.json`);
    const target = await realpath(path.dirname(manifest));
    const link = path.join(root, "node_modules", name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, "junction");
    externalTargets[name] = await realpath(manifest);
  }
  await buildHeadless({ outputDirectory: directory, portable: true, sourcemap: false, logLevel: "warning" });
  return { root, directory, externalTargets };
}

async function prepareFixture<T>(label: string, buildFixture: () => Promise<T>): Promise<OracleFixture<T>> {
  const started = performance.now();
  try {
    return { value: await buildFixture() };
  } catch (error) {
    // Surface the failure in its consumer and allow watch to try new source.
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    console.info(`[desktop-oracle-fixtures] ${label} took ${Math.round(performance.now() - started)} ms`);
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fixtures: Array<{ dispose(): Promise<void> }> = [];
  const prepareOwned = <T>(label: string, buildFixture: (root: string) => Promise<T>): Promise<OracleFixture<T>> => {
    // Retain earlier watch outputs until all workers have retired.
    const fixture = createNativeHelperFixture(buildFixture);
    fixtures.push(fixture);
    return prepareFixture(label, () => fixture.ready);
  };
  let preparing = Promise.resolve();
  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // Global setup runs before the pool applies its configured shard.
    const { config } = project.vitest;
    const selected = config.shard
      ? await new config.sequence.sequencer(project.vitest).shard([...specifications])
      : specifications;
    const files = new Set(selected.filter((spec) => spec.project === project).map((spec) => path.basename(spec.moduleId)));
    preparing = preparing.then(async () => {
      let builder: Promise<HeadlessBuilder> | undefined;
      const loadBuilder = () => builder ??= (async () => {
        // The global setup runner can retain evaluated imports on watch reruns.
        const digest = createHash("sha256").update(await readFile(headlessBuilder)).digest("hex");
        return project.import<HeadlessBuilder>(`${headlessBuilder}?oracleBuilderSource=${digest}`);
      })();
      if (files.has("headless-concurrency.oracle.test.ts") || files.has("headless-host.boot.oracle.test.ts")) {
        project.provide("headlessDriver", await prepareOwned("headless driver", async (root) => {
          const { buildHeadlessDriverFixture } = await import("../main/__tests__/helpers/headless-driver-fixture");
          return buildHeadlessDriverFixture(root, (await loadBuilder()).buildHeadless);
        }));
      }
      if (files.has("headless-portable-chunks.oracle.test.ts")) {
        project.provide("portableOutpost", await prepareOwned("portable Outpost", async (root) =>
          buildPortableOutpostFixture(root, (await loadBuilder()).buildHeadless)));
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
    await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  };
}
