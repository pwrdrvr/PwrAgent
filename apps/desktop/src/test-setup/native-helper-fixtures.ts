import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture, runNativeFixtureCommand } from "./native-helper-fixture";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const consumers = {
  maintenanceCargo: "maintenance-cargo-output.property.test.ts",
  mcpIpc: "mcp-ipc-http.test.ts",
} as const;
type Consumer = keyof typeof consumers;
type HelperPaths = { relay: string; identity?: string };

declare module "vitest" {
  export interface ProvidedContext {
    nativeHelperFixtures: Partial<Record<Consumer, HelperPaths>>;
  }
}

export function nativeHelperConsumers(files: readonly string[]): Consumer[] {
  const selected = new Set(files.map((file) => path.resolve(file)));
  return (Object.keys(consumers) as Consumer[]).filter((consumer) => selected.has(
    path.join(desktop, "src/main/__tests__", consumers[consumer]),
  ));
}

async function buildHelpers(root: string, identity: boolean): Promise<HelperPaths> {
  const builder = pathToFileURL(path.join(desktop, "scripts/build-mcp-ipc-relay.mjs")).href;
  await runNativeFixtureCommand(process.execPath, ["--input-type=module", "-e", `
    import { buildMcpIpcRelay } from ${JSON.stringify(builder)};
    buildMcpIpcRelay({ outputRoot: process.argv[1] });
    if (${identity}) buildMcpIpcRelay({ outputRoot: process.argv[1], identityTest: true });
  `, root]);
  const directory = path.join(root, "build/mcp-ipc-relay", `${process.platform}-${process.arch}`);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return {
    relay: path.join(directory, `mcp-ipc-relay${suffix}`),
    ...(identity ? { identity: path.join(directory, `mcp-ipc-identity-test${suffix}`) } : {}),
  };
}

// A selected suite receives completed, run-owned outputs. No worker hook owns
// compilation, and unrelated selections (including other shards) build none.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fixtures = new Map<Consumer, ReturnType<typeof createNativeHelperFixture<HelperPaths>>>();
  const paths: Partial<Record<Consumer, HelperPaths>> = {};
  const dispose = async (): Promise<void> => {
    await Promise.all([...fixtures.values()].map((fixture) => fixture.dispose()));
  };
  const prepare = async (specifications: TestSpecification[]): Promise<void> => {
    // Vitest applies sharding inside the pool, after global setup. Follow the
    // configured sequencer, as the CI completeness reporter does.
    const selected = project.vitest.config.shard
      ? await new project.vitest.config.sequence.sequencer(project.vitest).shard(specifications)
      : specifications;
    const required = nativeHelperConsumers(selected.filter((spec) => spec.project === project).map((spec) => spec.moduleId));
    await Promise.all(required.map(async (consumer) => {
      let fixture = fixtures.get(consumer);
      if (!fixture) {
        console.info(`[native-helper-fixtures] preparing ${consumer}`);
        fixture = createNativeHelperFixture((root) => buildHelpers(root, consumer === "mcpIpc"));
        fixtures.set(consumer, fixture);
      }
      paths[consumer] = await fixture.ready;
      console.info(`[native-helper-fixtures] ready ${consumer}`);
    }));
    project.provide("nativeHelperFixtures", { ...paths });
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
