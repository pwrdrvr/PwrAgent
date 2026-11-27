import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestProject, TestSpecification } from "vitest/node";
import { createNativeHelperFixture, runNativeFixtureCommand } from "./native-helper-fixture";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const consumers = {
  maintenanceCargo: "maintenance-cargo-output.property.test.ts",
  maintenanceAllocation: "maintenance-disk-usage.property.test.ts",
  mcpIpc: "mcp-ipc-http.test.ts",
  markerProbe: "thread-dependency-marker-probe.property.test.ts",
  stackEngine: ["stack-engine-ports.test.ts", "stack-provisioning.property.test.ts", "stack-recovery.property.test.ts"],
  windowsGitJobLauncher: "windows-git-job-launcher.test.ts",
} as const;
const pipeProbeTest = path.join(desktop, "scripts/windows-pipe-observation.test.mjs");
type Consumer = keyof typeof consumers | "windowsPipeProbe";
type WindowsConsumer = "windowsGitJobLauncher" | "windowsPipeProbe";
type HelperPaths = { relay: string; identity?: string };
type FixturePaths = Partial<Record<Exclude<Consumer, WindowsConsumer>, HelperPaths> & Record<WindowsConsumer, string>>;

declare module "vitest" {
  export interface ProvidedContext {
    nativeHelperFixtures: FixturePaths;
  }
}

export function nativeHelperConsumers(files: readonly string[], platform = process.platform, arch = process.arch): Consumer[] {
  const selected = new Set(files.map((file) => path.resolve(file)));
  const required: Consumer[] = (Object.keys(consumers) as (keyof typeof consumers)[]).filter((consumer) =>
    (consumer !== "windowsGitJobLauncher" || platform === "win32")
    && [consumers[consumer]].flat().some((filename) => selected.has(path.join(desktop, "src/main/__tests__", filename))));
  if (platform === "win32" && arch === "x64" && selected.has(pipeProbeTest)) required.push("windowsPipeProbe");
  return required;
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

async function prepareHelper(root: string, consumer: Consumer): Promise<FixturePaths> {
  if (consumer === "windowsGitJobLauncher") {
    await runNativeFixtureCommand(process.execPath, [path.join(desktop, "scripts/build-windows-job-launcher.mjs"), root]);
    const launcher = path.join(root, "pwragent-windows-job.exe");
    await access(launcher);
    return { windowsGitJobLauncher: launcher };
  }
  if (consumer === "windowsPipeProbe") {
    const executable = path.join(root, "native.exe");
    const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await runNativeFixtureCommand(compiler, [
      "/nologo", "/platform:x64", "/r:System.Web.Extensions.dll", `/out:${executable}`,
      path.join(desktop, "scripts/windows-pipe-diagnostics.cs"),
    ]);
    await access(executable);
    return { windowsPipeProbe: executable };
  }
  return { [consumer]: await buildHelpers(root, consumer === "mcpIpc" || consumer === "markerProbe") };
}

// A selected suite receives completed, run-owned outputs. No worker hook owns
// compilation, and unrelated selections (including other shards) build none.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fixtures = new Map<Consumer, ReturnType<typeof createNativeHelperFixture<FixturePaths>>>();
  const paths: FixturePaths = {};
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
        fixture = createNativeHelperFixture((root) => prepareHelper(root, consumer));
        fixtures.set(consumer, fixture);
      }
      try {
        Object.assign(paths, await fixture.ready);
      } catch (error) {
        console.error(`[native-helper-fixtures] ${consumer} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
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
