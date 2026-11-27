import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture } from "./native-helper-fixture";
import type { OracleFixture, PortableOutpostFixture } from "./oracle-fixture-context";

const headlessBuilder = fileURLToPath(new URL("../../scripts/build-headless.mjs", import.meta.url));
const outpostManifest = fileURLToPath(new URL("../../../../packages/pwragent/package.json", import.meta.url));
const packagedOutput = fileURLToPath(new URL("../../../../packages/pwragent/dist", import.meta.url));
const testDirectory = fileURLToPath(new URL("../main/__tests__/", import.meta.url));
type HeadlessBuilder = typeof import("../../scripts/build-headless.mjs");

async function buildPortableOutpostFixture(root: string, emit: (directory: string) => Promise<void>): Promise<PortableOutpostFixture> {
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
  await emit(directory);
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
  type FixtureKey = "headlessDriver" | "portableOutpost";
  const fixtures = new Map<FixtureKey, { dispose(): Promise<void> }>();
  const prepareOwned = async <T>(
    key: FixtureKey,
    label: string,
    buildFixture: (root: string) => Promise<T>,
    publish: (output: OracleFixture<T>) => void,
    rerun: boolean,
  ): Promise<void> => {
    const fixture = createNativeHelperFixture(buildFixture);
    const output = await prepareFixture(label, () => fixture.ready);
    // A rerun can be requested while earlier workers still hold those paths.
    if (rerun) await project.vitest.waitForTestRunEnd();
    const previous = fixtures.get(key);
    publish(output);
    fixtures.set(key, fixture);
    await previous?.dispose();
  };
  const normalizeFile = (file: string) => file.replaceAll("\\", "/");
  const consumer = (file: string) => normalizeFile(path.join(testDirectory, file));
  let preparing = Promise.resolve();
  const prepare = async (specifications: TestSpecification[], rerun = false): Promise<void> => {
    // Global setup runs before the pool applies its configured shard.
    const { config } = project.vitest;
    const selected = config.shard
      ? await new config.sequence.sequencer(project.vitest).shard([...specifications])
      : specifications;
    const files = new Set(selected.filter((spec) => spec.project === project).map((spec) => normalizeFile(spec.moduleId)));
    preparing = preparing.then(async () => {
      let builder: Promise<HeadlessBuilder> | undefined;
      const loadBuilder = () => builder ??= (async () => {
        // The global setup runner can retain evaluated imports on watch reruns.
        const digest = createHash("sha256").update(await readFile(headlessBuilder)).digest("hex");
        return project.import<HeadlessBuilder>(`${normalizeFile(headlessBuilder)}?oracleBuilderSource=${digest}`);
      })();
      if (files.has(consumer("headless-concurrency.oracle.test.ts")) || files.has(consumer("headless-host.boot.oracle.test.ts"))) {
        await prepareOwned("headlessDriver", "headless driver", async (root) => {
          const { buildHeadlessDriverFixture } = await import("../main/__tests__/helpers/headless-driver-fixture");
          return buildHeadlessDriverFixture(root, (await loadBuilder()).buildHeadless);
        }, output => project.provide("headlessDriver", output), rerun);
      }
      if (files.has(consumer("headless-portable-chunks.oracle.test.ts"))) {
        // Global setup already built the packaged output for the initial run.
        // Watch workers need freshly emitted chunks from the current source.
        await prepareOwned("portableOutpost", "portable Outpost", (root) => buildPortableOutpostFixture(root, async (directory) => {
          if (rerun) {
            const { buildHeadless } = await loadBuilder();
            await buildHeadless({ outputDirectory: directory, portable: true, sourcemap: false, logLevel: "warning" });
          } else {
            await cp(packagedOutput, directory, { recursive: true });
          }
        }), output => project.provide("portableOutpost", output), rerun);
      }
      if (files.has(consumer("production-entry-host.oracle.test.ts"))) {
        project.provide("desktopEntryHasFileKey", await prepareFixture("desktop entry", async () => {
          const { desktopEntryHasFileKey } = await import("../main/__tests__/helpers/production-entry-bundle");
          return desktopEntryHasFileKey();
        }));
      }
    });
    await preparing;
  };
  await prepare(project.vitest.state.getPaths().flatMap((file) => project.vitest.getModuleSpecifications(file)));
  project.onTestsRerun((specifications) => prepare(specifications, true));
  return async () => {
    await preparing;
    await Promise.all([...fixtures.values()].map((fixture) => fixture.dispose()));
  };
}
