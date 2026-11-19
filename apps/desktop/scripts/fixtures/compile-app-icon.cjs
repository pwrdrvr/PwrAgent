const { writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { join } = require("node:path");

// The detached group survives Ctrl-C. Its IPC channel closes when the
// Vitest worker exits, even if its deadline never gets a chance to run.
process.once("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.channel?.unref();

async function main() {
  const [iconPackage, outputDir] = process.argv.slice(2);
  const fromElectronBuilder = createRequire(require.resolve("electron-builder"));
  const { generateAssetCatalogForIcon } = fromElectronBuilder("app-builder-lib/out/util/macosIconComposer");
  const { assetCatalog, icnsFile } = await generateAssetCatalogForIcon(iconPackage);
  await Promise.all([
    writeFile(join(outputDir, "Assets.car"), assetCatalog),
    writeFile(join(outputDir, "Icon.icns"), icnsFile),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
