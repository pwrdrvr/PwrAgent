const { writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { join } = require("node:path");

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
